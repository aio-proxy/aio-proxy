import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, win32 } from 'node:path';

import { m } from '@aio-proxy/i18n';

import { CliExit, EXIT } from '../../exit';
import { createStyle } from '../../ui';
import { accountForSid, currentUserSid as nativeUserSid, processImagePath, sidForAccount } from '../../win32-ffi';
import { type CaptureResult, runCapture } from '../run-capture';
import {
  isOwnTask,
  type ParsedTask,
  parseServiceSpec,
  parseTaskXml,
  renderServiceSpec,
  renderTaskXml,
  serviceSpecPath,
  serviceStatePath,
  taskPath,
} from '../schtasks-unit';
import { parseSupervisorState, supervisorAlive } from '../supervisor-state';
import { uninstallMarkerPath } from '../uninstall-marker';
import type { UnitOptions } from '../unit-templates';

type Run = (cmd: readonly string[], allowFailure?: boolean) => Promise<number>;
type Capture = (cmd: readonly string[]) => Promise<CaptureResult>;

export type SchtasksIo = {
  /** Mutating schtasks commands; their output is streamed to the user. */
  readonly run: Run;
  /** Queries; their output is parsed, never shown. */
  readonly capture: Capture;
  readonly sid: string;
  /** Resolves an account name to its SID: exported task XML may name the principal by account instead. */
  readonly sidForAccount: (account: string) => string | undefined;
  readonly localAppData: string;
  /** Where the task XML is staged for `/Create /XML`. */
  readonly tempDir: string;
  /** The unit to write: resolved only by the commands that write one. */
  readonly unit: () => Promise<UnitOptions>;
  readonly readFile: (path: string) => string | undefined;
  readonly writeFile: (path: string, data: string | Uint8Array) => void;
  readonly rename: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
  /** A process's full image path, to tell the supervisor from a later process given its PID. */
  readonly imagePath: (pid: number) => string | undefined;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** One line for the user on stderr. */
  readonly warn: (line: string) => void;
};

export type TaskQuery = { kind: 'found'; xml: string } | { kind: 'missing' } | { kind: 'failed'; code: number };

const TASK_NOT_FOUND = 3;
const SUPERVISOR_EXIT_TIMEOUT_MS = 10_000;
const SUPERVISOR_POLL_MS = 100;

const commandFailed = (cmd: readonly string[], code: number): CliExit =>
  new CliExit(EXIT.transient, m['cli.service.command_failed']({ command: cmd.join(' '), code }));

export function windowsLocalAppData(env: NodeJS.ProcessEnv): string {
  const value = env['LOCALAPPDATA'];
  if (value === undefined || value === '')
    throw new CliExit(EXIT.unrecoverable, m['cli.service.local_app_data_missing']());
  return value;
}

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

const psQuoted = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/**
 * Exports the task XML as UTF-8 so non-ASCII paths and accounts read back exactly; `schtasks /Query /XML`
 * writes it in an unverified encoding. Exits 3 when the task does not exist.
 */
const taskXmlCommand = (path: string): string[] => {
  const split = path.lastIndexOf('\\') + 1;
  const where = `-TaskPath ${psQuoted(path.slice(0, split))} -TaskName ${psQuoted(path.slice(split))}`;
  return [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $t = Get-ScheduledTask ${where} -ErrorAction SilentlyContinue; ` +
      `if ($null -eq $t) { exit ${TASK_NOT_FOUND} } else { Export-ScheduledTask ${where} }`,
  ];
};

export async function queryTaskXml(capture: Capture, path: string): Promise<TaskQuery> {
  const { code, stdout } = await capture(taskXmlCommand(path));
  if (code === 0) return { kind: 'found', xml: stdout };
  return code === TASK_NOT_FOUND ? { kind: 'missing' } : { kind: 'failed', code };
}

/**
 * Our task, or undefined when it does not exist; refuses one that runs as someone else. The queried XML is only
 * read for whose it is, never fed back to `/Create`: Task Scheduler may have rewritten it.
 */
async function ownTask(io: SchtasksIo, path: string): Promise<ParsedTask | undefined> {
  const query = await queryTaskXml(io.capture, path);
  if (query.kind === 'failed') throw commandFailed(taskXmlCommand(path), query.code);
  if (query.kind === 'missing') return undefined;
  const task = parseTaskXml(query.xml);
  if (!isOwnTask(task, io)) throw new CliExit(EXIT.unrecoverable, m['cli.service.task_owned_by_other_user']({ path }));
  return task;
}

const ownTaskExists = async (io: SchtasksIo, path: string): Promise<boolean> => (await ownTask(io, path)) !== undefined;

// schtasks reads the XML file in the encoding its declaration names, and renderTaskXml declares UTF-16.
function stageTaskXml(io: SchtasksIo, xml: string): string {
  const file = win32.join(io.tempDir, `aio-proxy-task-${randomUUID()}.xml`);
  io.writeFile(file, Buffer.from(`﻿${xml}`, 'utf16le'));
  return file;
}

async function createTask(io: SchtasksIo, path: string, file: string): Promise<void> {
  try {
    await io.run(['schtasks', '/Create', '/XML', file, '/TN', path, '/F']);
  } finally {
    io.remove(file);
  }
}

async function renderUnit(io: SchtasksIo): Promise<{ spec: string; xml: string }> {
  const unit = await io.unit();
  const specPath = serviceSpecPath(io.localAppData);
  return {
    spec: `${JSON.stringify(renderServiceSpec(unit), null, 2)}\n`,
    xml: renderTaskXml({ sid: io.sid, exec: unit.exec, specPath }),
  };
}

const endTask = (io: SchtasksIo, path: string) => io.run(['schtasks', '/End', '/TN', path], true);
const runTask = (io: SchtasksIo, path: string) => io.run(['schtasks', '/Run', '/TN', path]);

export async function schtasksInstall(io: SchtasksIo): Promise<void> {
  const path = taskPath(io.sid);
  await ownTaskExists(io, path);
  io.remove(uninstallMarkerPath('win32', { LOCALAPPDATA: io.localAppData })!);
  const { spec, xml } = await renderUnit(io);
  const file = stageTaskXml(io, xml);
  io.writeFile(serviceSpecPath(io.localAppData), spec);
  await createTask(io, path, file);
}

export async function schtasksStart(io: SchtasksIo): Promise<void> {
  const path = taskPath(io.sid);
  // A spec without its task (a failed `/Create`, or the task deleted by hand) can only be fixed by creating it again.
  if (!(await ownTaskExists(io, path))) await schtasksInstall(io);
  else await io.run(['schtasks', '/Change', '/TN', path, '/ENABLE']);
  await runTask(io, path);
}

// Disabling makes the stop survive the next logon, which would otherwise start the task again.
export async function schtasksStop(io: SchtasksIo): Promise<void> {
  const path = taskPath(io.sid);
  // Stopping a task that does not exist is already done.
  if (!(await ownTaskExists(io, path))) return;
  await endTask(io, path);
  await io.run(['schtasks', '/Change', '/TN', path, '/DISABLE']);
}

export async function schtasksRestart(io: SchtasksIo): Promise<void> {
  const path = taskPath(io.sid);
  const specPath = serviceSpecPath(io.localAppData);
  await ownTaskExists(io, path);
  const previousSpec = io.readFile(specPath);
  // Stage both files first, so a failed write leaves the running task untouched.
  const { spec, xml } = await renderUnit(io);
  const staged = `${specPath}.new`;
  io.writeFile(staged, spec);
  const file = stageTaskXml(io, xml);
  await endTask(io, path);
  try {
    // `/Create /F` replaces the action and leaves the task enabled, undoing a `service stop`.
    await createTask(io, path, file);
    io.rename(staged, specPath);
    await runTask(io, path);
  } catch (error) {
    io.remove(staged);
    // Bring the previous definition back rather than leave the proxy offline. It is rendered from the
    // spec we wrote, which names the same exec and spec path the previous task XML did.
    try {
      if (previousSpec === undefined) io.remove(specPath);
      else io.writeFile(specPath, previousSpec);
      const previousExec = previousSpec === undefined ? undefined : parseServiceSpec(previousSpec)?.exec;
      if (previousExec === undefined) throw new Error('no readable previous service spec');
      await createTask(io, path, stageTaskXml(io, renderTaskXml({ sid: io.sid, exec: previousExec, specPath })));
      await runTask(io, path);
    } catch {
      io.warn(`${createStyle(process.stderr).mark('warn')} ${m['cli.service.restore_failed']()}`);
    }
    throw error;
  }
}

/** Ends the process after `ms`, from a ref'd timer so the exit still fires when nothing else keeps the loop alive. */
export const exitProcessLater = (code: number, ms: number): void => {
  setTimeout(() => process.exit(code), ms);
};

/**
 * Restart from inside the service. `/End` would kill our own supervisor (and, through its Job Object, this
 * process) before `/Run`, so instead refresh the spec (and the task when its `exec` or spec path moved) and exit with the
 * restart code: the supervisor re-reads the spec and relaunches. Returns normally so a caller that awaits the
 * restart (the auto-update task) does not see a failure.
 */
export async function schtasksRestartInService(
  io: SchtasksIo,
  scheduleExit: (code: number, ms: number) => void,
): Promise<void> {
  const path = taskPath(io.sid);
  const specPath = serviceSpecPath(io.localAppData);
  const { spec, xml } = await renderUnit(io);
  const staged = `${specPath}.new`;
  io.writeFile(staged, spec);
  try {
    // A failed query or a foreign task throws before anything is written: `/Create /F` would overwrite it.
    // The supervisor re-reads the spec the task names, so a stale spec path needs a new task as much as a moved exec.
    const action = (await ownTask(io, path))?.action;
    const exec = parseServiceSpec(spec)?.exec;
    const current =
      action !== undefined &&
      exec !== undefined &&
      action.exec.toLowerCase() === exec.toLowerCase() &&
      action.specPath.toLowerCase() === specPath.toLowerCase();
    if (!current) await createTask(io, path, stageTaskXml(io, xml));
    io.rename(staged, specPath);
  } catch (error) {
    io.remove(staged);
    throw error;
  }
  scheduleExit(EXIT.restartRequested, 1000);
}

// `/End` kills the supervisor, whose Job Object takes the proxy with it; `/Delete` alone would leave both running.
export async function schtasksUninstall(io: SchtasksIo): Promise<void> {
  const path = taskPath(io.sid);
  if (await ownTaskExists(io, path)) {
    await endTask(io, path);
    const state = parseSupervisorState(io.readFile(serviceStatePath(io.localAppData)));
    const deadline = io.now() + SUPERVISOR_EXIT_TIMEOUT_MS;
    while (supervisorAlive(state, io.imagePath)) {
      if (io.now() >= deadline) {
        throw new CliExit(
          EXIT.transient,
          m['cli.service.supervisor_timeout']({ seconds: SUPERVISOR_EXIT_TIMEOUT_MS / 1000 }),
        );
      }
      await io.sleep(SUPERVISOR_POLL_MS);
    }
    await io.run(['schtasks', '/Delete', '/TN', path, '/F']);
  }
  io.remove(serviceSpecPath(io.localAppData));
  io.remove(serviceStatePath(io.localAppData));
  io.writeFile(uninstallMarkerPath('win32', { LOCALAPPDATA: io.localAppData })!, '');
}

/** Prints the task, then exits 0 only when the supervisor runs: a registered but stopped or disabled task is not active. */
export async function schtasksStatus(
  io: Pick<SchtasksIo, 'run' | 'sid' | 'localAppData' | 'readFile' | 'imagePath'>,
): Promise<number> {
  const code = await io.run(['schtasks', '/Query', '/TN', taskPath(io.sid), '/V', '/FO', 'LIST'], true);
  if (code !== 0) return code;
  const state = parseSupervisorState(io.readFile(serviceStatePath(io.localAppData)));
  return supervisorAlive(state, io.imagePath) ? 0 : EXIT.transient;
}

export async function defaultSchtasksIo(
  run: Run,
  unit: () => Promise<UnitOptions>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SchtasksIo> {
  const localAppData = windowsLocalAppData(env);
  const { sid } = await currentUser(runCapture);
  return {
    run,
    capture: runCapture,
    sid,
    sidForAccount,
    localAppData,
    tempDir: tmpdir(),
    unit,
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    writeFile: (path, data) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
    },
    rename: renameSync,
    remove: (path) => rmSync(path, { force: true }),
    imagePath: processImagePath,
    sleep: (ms) => Bun.sleep(ms),
    now: Date.now,
    warn: (line) => console.error(line),
  };
}
