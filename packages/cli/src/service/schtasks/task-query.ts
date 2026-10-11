import { m } from '@aio-proxy/i18n';

import { CliExit, EXIT } from '../../exit';
import { accountForSid, currentUserSid as nativeUserSid } from '../../win32-ffi';
import type { CaptureResult } from '../run-capture';
import { isOwnTask, type ParsedTask, parseTaskXml, type WindowsUser } from '../schtasks-unit';

export type Capture = (cmd: readonly string[]) => Promise<CaptureResult>;

export type TaskQuery = { kind: 'found'; xml: string } | { kind: 'missing' } | { kind: 'failed'; code: number };

// `schtasks /HRESULT` exits with the HRESULT: ERROR_FILE_NOT_FOUND (0x80070002) is the task not existing, and
// ERROR_PATH_NOT_FOUND (0x80070003) the same once the \AIO Proxy folder went with its last task. Bun keeps only the
// exit code's low byte on Windows, so they arrive as 2 and 3 (access denied, 0x80070005, as 5; a plain failure, 1).
const NOT_FOUND = [0x80070002, 0x80070003];
const isTaskNotFound = (code: number): boolean =>
  NOT_FOUND.some((hresult) => code === hresult || code === (hresult | 0) || code === (hresult & 0xff));

const commandFailed = (cmd: readonly string[], code: number): CliExit =>
  new CliExit(EXIT.transient, m['cli.service.command_failed']({ command: cmd.join(' '), code }));

/** The current user from the token, in UTF-16; undefined when FFI is unavailable or fails. */
const nativeUser = (): { sid: string; account: string } | undefined => {
  const sid = nativeUserSid();
  const account = sid === undefined ? undefined : accountForSid(sid);
  return sid === undefined || account === undefined ? undefined : { sid, account };
};

// whoami prints the console code page through a pipe, which garbles a non-ASCII account: it is only the fallback.
export async function currentUser(
  capture: Capture,
  native: () => { sid: string; account: string } | undefined = nativeUser,
): Promise<{ sid: string; account: string }> {
  const own = native();
  if (own !== undefined) return own;
  const cmd = ['whoami', '/user', '/fo', 'csv', '/nh'];
  const { code, stdout } = await capture(cmd);
  // `"DOMAIN\user","S-1-5-21-…"`: user names cannot contain a double quote.
  const match = /^"([^"]+)","(S-1-[\d-]+)"$/.exec(stdout.trim());
  if (code !== 0 || match === null) throw commandFailed(cmd, code);
  return { account: match[1]!, sid: match[2]! };
}

export const currentUserSid = async (capture: Capture): Promise<string> => (await currentUser(capture)).sid;

/**
 * `schtasks /Query /XML`, run under `chcp 65001` so the XML (and any non-ASCII path or account in it) reaches the pipe
 * as UTF-8 rather than in the console code page. PowerShell's Get-ScheduledTask returned the same data but took
 * seconds to load its CIM module, over the time `__desktop-connect` has. `cmd /s /c "…"` strips only the outer quotes,
 * so the arguments go verbatim (see `windowsVerbatimArguments` in runCapture).
 */
const taskXmlCommand = (path: string): string[] => [
  'cmd.exe',
  '/d',
  '/s',
  '/c',
  `"chcp 65001 >nul & schtasks /Query /XML /TN "${path}" /HRESULT"`,
];

export async function queryTaskXml(capture: Capture, path: string): Promise<TaskQuery> {
  const { code, stdout } = await capture(taskXmlCommand(path));
  if (code === 0) return { kind: 'found', xml: stdout };
  return isTaskNotFound(code) ? { kind: 'missing' } : { kind: 'failed', code };
}

/**
 * Our task, or undefined when it does not exist; refuses one that runs as someone else. The queried XML is only
 * read for whose it is, never fed back to `/Create`: Task Scheduler may have rewritten it.
 */
export async function ownTask(
  io: WindowsUser & { readonly capture: Capture },
  path: string,
): Promise<ParsedTask | undefined> {
  const query = await queryTaskXml(io.capture, path);
  if (query.kind === 'failed') throw commandFailed(taskXmlCommand(path), query.code);
  if (query.kind === 'missing') return undefined;
  const task = parseTaskXml(query.xml);
  if (!isOwnTask(task, io)) throw new CliExit(EXIT.unrecoverable, m['cli.service.task_owned_by_other_user']({ path }));
  return task;
}
