import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, win32 } from 'node:path';

import { m } from '@aio-proxy/i18n';
import { isPlainObject } from 'es-toolkit/predicate';

import { CliExit, EXIT } from '../../exit';
import { processImagePath } from '../../win32-ffi';
import { type CaptureResult, runCapture } from '../run-capture';
import { renderServiceSpec, renderTaskXml, serviceSpecPath, serviceStatePath, taskPath } from '../schtasks-unit';
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
  readonly localAppData: string;
  /** Where the task XML is staged for `/Create /XML`. */
  readonly tempDir: string;
  /** The unit to write: resolved only by the commands that write one. */
  readonly unit: () => Promise<UnitOptions>;
  readonly readFile: (path: string) => string | undefined;
  readonly writeFile: (path: string, data: string | Uint8Array) => void;
  readonly rename: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
  readonly pidAlive: (pid: number) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
};

export type TaskQuery = { kind: 'found'; xml: string } | { kind: 'missing' } | { kind: 'failed'; code: number };

// `/HRESULT` makes schtasks exit with the HRESULT; Bun may report it signed or unsigned.
const TASK_NOT_FOUND = 0x80070002;
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

export async function currentUserSid(capture: Capture): Promise<string> {
  const cmd = ['whoami', '/user', '/fo', 'csv', '/nh'];
  const { code, stdout } = await capture(cmd);
  // `"DOMAIN\user","S-1-5-21-…"`: user names cannot contain a double quote.
  const sid = /^"[^"]*","(S-1-[\d-]+)"$/.exec(stdout.trim())?.[1];
  if (code !== 0 || sid === undefined) throw commandFailed(cmd, code);
  return sid;
}

export async function queryTaskXml(capture: Capture, path: string): Promise<TaskQuery> {
  const { code, stdout } = await capture(['schtasks', '/Query', '/XML', '/TN', path, '/HRESULT']);
  if (code === 0) return { kind: 'found', xml: stdout };
  return code === TASK_NOT_FOUND || code === (TASK_NOT_FOUND | 0) ? { kind: 'missing' } : { kind: 'failed', code };
}

function taskPrincipal(xml: string): unknown {
  try {
    const task = (Bun.XML.parse(xml) as Record<string, unknown>)['Task'];
    const principals = isPlainObject(task) ? task['Principals'] : undefined;
    const principal = isPlainObject(principals) ? principals['Principal'] : undefined;
    return isPlainObject(principal) ? principal['UserId'] : undefined;
  } catch {
    return undefined;
  }
}

/** The current task definition, or undefined when none exists. Never hands back a task that runs as someone else. */
async function queryOwnTask(io: SchtasksIo, path: string): Promise<string | undefined> {
  const query = await queryTaskXml(io.capture, path);
  if (query.kind === 'failed') throw commandFailed(['schtasks', '/Query', '/XML', '/TN', path], query.code);
  if (query.kind === 'missing') return undefined;
  if (taskPrincipal(query.xml) !== io.sid) {
    throw new CliExit(EXIT.unrecoverable, m['cli.service.task_owned_by_other_user']({ path }));
  }
  return query.xml;
}

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

function readSupervisorPid(io: SchtasksIo): number | undefined {
  try {
    const state: unknown = JSON.parse(io.readFile(serviceStatePath(io.localAppData)) ?? '');
    const pid = isPlainObject(state) ? state['pid'] : undefined;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

const endTask = (io: SchtasksIo, path: string) => io.run(['schtasks', '/End', '/TN', path], true);
const runTask = (io: SchtasksIo, path: string) => io.run(['schtasks', '/Run', '/TN', path]);

export async function schtasksInstall(io: SchtasksIo): Promise<void> {
  const path = taskPath(io.sid);
  await queryOwnTask(io, path);
  io.remove(uninstallMarkerPath('win32', { LOCALAPPDATA: io.localAppData })!);
  const { spec, xml } = await renderUnit(io);
  const file = stageTaskXml(io, xml);
  io.writeFile(serviceSpecPath(io.localAppData), spec);
  await createTask(io, path, file);
}

export async function schtasksStart(io: SchtasksIo): Promise<void> {
  const path = taskPath(io.sid);
  await io.run(['schtasks', '/Change', '/TN', path, '/ENABLE']);
  await runTask(io, path);
}

// Disabling makes the stop survive the next logon, which would otherwise start the task again.
export async function schtasksStop(io: SchtasksIo): Promise<void> {
  const path = taskPath(io.sid);
  await endTask(io, path);
  await io.run(['schtasks', '/Change', '/TN', path, '/DISABLE']);
}

export async function schtasksRestart(io: SchtasksIo): Promise<void> {
  const path = taskPath(io.sid);
  const specPath = serviceSpecPath(io.localAppData);
  const previousXml = await queryOwnTask(io, path);
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
    // Bring the previous definition back rather than leave the proxy offline.
    try {
      if (previousSpec === undefined) io.remove(specPath);
      else io.writeFile(specPath, previousSpec);
      if (previousXml !== undefined) {
        await createTask(io, path, stageTaskXml(io, previousXml));
        await runTask(io, path);
      }
    } catch {}
    throw error;
  }
}

// `/End` kills the supervisor, whose Job Object takes the proxy with it; `/Delete` alone would leave both running.
export async function schtasksUninstall(io: SchtasksIo): Promise<void> {
  const path = taskPath(io.sid);
  if ((await queryOwnTask(io, path)) !== undefined) {
    await endTask(io, path);
    const pid = readSupervisorPid(io);
    const deadline = io.now() + SUPERVISOR_EXIT_TIMEOUT_MS;
    while (pid !== undefined && io.pidAlive(pid)) {
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

export const schtasksStatus = (run: Run, sid: string): Promise<number> =>
  run(['schtasks', '/Query', '/TN', taskPath(sid), '/V', '/FO', 'LIST'], true);

export async function defaultSchtasksIo(
  run: Run,
  unit: () => Promise<UnitOptions>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SchtasksIo> {
  const localAppData = windowsLocalAppData(env);
  return {
    run,
    capture: runCapture,
    sid: await currentUserSid(runCapture),
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
    pidAlive: (pid) => processImagePath(pid) !== undefined,
    sleep: (ms) => Bun.sleep(ms),
    now: Date.now,
  };
}
