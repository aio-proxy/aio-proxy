import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';

import { m } from '@aio-proxy/i18n';

import { CliExit, EXIT } from '../../exit';
import { createStyle } from '../../ui';
import {
  type ParsedTask,
  parseServiceSpec,
  parseTaskXml,
  renderServiceSpec,
  renderTaskXml,
  serviceSpecPath,
  serviceStatePath,
  serviceStatePathBeside,
  taskPath,
} from '../schtasks-unit';
import { parseSupervisorState, supervisorAlive } from '../supervisor-state';
import { uninstallMarkerPath } from '../uninstall-marker';
import type { SchtasksIo } from './io';
import { ownTask, queryTaskXml } from './task-query';

const SUPERVISOR_EXIT_TIMEOUT_MS = 10_000;
const SUPERVISOR_POLL_MS = 100;

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

/** Whether the task already runs the unit's exec from the spec path (the supervisor re-reads that spec). */
const taskCurrent = (action: ParsedTask['action'] | undefined, exec: string | undefined, specPath: string): boolean =>
  action !== undefined &&
  exec !== undefined &&
  action.exec.toLowerCase() === exec.toLowerCase() &&
  action.specPath.toLowerCase() === specPath.toLowerCase();

// Same rule as readDesktopOwnedUnit: the unit's program is the symlink the app recorded in its environment.
const desktopOwned = (unit: ReturnType<typeof parseServiceSpec>): boolean => {
  const marker = unit?.env['AIO_PROXY_DESKTOP_EXEC'];
  return marker !== undefined && marker !== '' && marker === unit?.exec;
};

/**
 * `/End` terminates only the task's own process, `conhost --headless`, and not the supervisor it hosts, so the
 * supervisor (and through its Job Object the proxy) outlives it: terminate the recorded supervisor ourselves.
 */
async function endTask(io: SchtasksIo, path: string, task: ParsedTask | undefined): Promise<void> {
  await io.run(['schtasks', '/End', '/TN', path], true);
  await endSupervisor(io, task);
}
const runTask = (io: SchtasksIo, path: string) => io.run(['schtasks', '/Run', '/TN', path]);

/** Returns what the spec path held before, for a caller that must put it back after a later failure. */
async function replaceSpecAndTask(
  io: SchtasksIo,
  path: string,
  specPath: string,
  spec: string,
  xml: string,
): Promise<string | undefined> {
  const previous = io.readFile(specPath);
  const staged = `${specPath}.new`;
  io.writeFile(staged, spec);
  try {
    io.rename(staged, specPath);
  } catch (error) {
    io.remove(staged);
    throw error;
  }
  try {
    await createTask(io, path, stageTaskXml(io, xml));
  } catch (error) {
    if (previous === undefined) io.remove(specPath);
    else io.writeFile(specPath, previous);
    throw error;
  }
  return previous;
}

export async function schtasksInstall(io: SchtasksIo): Promise<void> {
  const path = taskPath(io.sid);
  const existing = await ownTask(io, path);
  const { spec, xml } = await renderUnit(io);
  // Spec and task change together: the spec moves in first (an atomic rename, so the task is never left without one),
  // and a failed `/Create` puts the previous spec back, since a running task re-reads it on its next relaunch.
  const specPath = serviceSpecPath(io.localAppData);
  // A task on an older LOCALAPPDATA or profile path has a supervisor watching that old spec: replacing the task
  // would orphan it (status and stop follow the new task). It is ended first and, if it was running, restarted below.
  const migrating = existing?.action !== undefined && existing.action.specPath.toLowerCase() !== specPath.toLowerCase();
  let wasRunning = false;
  if (migrating) {
    const state = parseSupervisorState(io.readFile(supervisorStatePath(io, existing)));
    wasRunning = supervisorAlive(state, io.imagePath, io.creationTime);
    await endTask(io, path, existing);
  }
  let previousAtSpecPath: string | undefined;
  try {
    previousAtSpecPath = await replaceSpecAndTask(io, path, specPath, spec, xml);
  } catch (error) {
    // The old task and its spec are back as they were: relaunch the supervisor ended above rather than leave the proxy
    // offline, and still report the failure.
    if (wasRunning) await io.run(['schtasks', '/Run', '/TN', path], true).catch(() => {});
    throw error;
  }
  io.remove(uninstallMarkerPath('win32', { LOCALAPPDATA: io.localAppData })!);
  if (!wasRunning) return;
  try {
    await runTask(io, path);
  } catch (error) {
    // The replacement will not start: put the migrated task back on its own (untouched) spec and run that, so the
    // proxy that was serving before the install keeps serving, and report the failure.
    try {
      if (previousAtSpecPath === undefined) io.remove(specPath);
      else io.writeFile(specPath, previousAtSpecPath);
      const oldSpecPath = existing!.action!.specPath;
      const oldExec = parseServiceSpec(io.readFile(oldSpecPath) ?? '')?.exec ?? existing!.action!.exec;
      await createTask(
        io,
        path,
        stageTaskXml(io, renderTaskXml({ sid: io.sid, exec: oldExec, specPath: oldSpecPath })),
      );
      await io.run(['schtasks', '/Run', '/TN', path], true);
    } catch {
      io.warn(`${createStyle(process.stderr).mark('warn')} ${m['cli.service.restore_failed']()}`);
    }
    throw error;
  }
}

export async function schtasksStart(io: SchtasksIo): Promise<void> {
  const path = taskPath(io.sid);
  // A spec without its task (a failed `/Create`, or the task deleted by hand) can only be fixed by creating it again.
  const task = await ownTask(io, path);
  const refresh = task ? await refreshesStaleTask(io, task) : 'reinstall';
  // A stale task may still have a supervisor on its old spec; `/Run` would be ignored next to it (IgnoreNew), and
  // stop/status would follow the new task and miss it. End it before the task is replaced.
  // (install ends a task on an older spec path itself, so only a same-path stale task is ended here).
  if (
    refresh === 'reinstall' &&
    task &&
    task.action?.specPath.toLowerCase() === serviceSpecPath(io.localAppData).toLowerCase()
  )
    await endTask(io, path, task);
  if (refresh === 'reinstall') await schtasksInstall(io);
  else if (refresh === 'repair-action') await repairAction(io, path, ownedSpecPath(io, task));
  else await io.run(['schtasks', '/Change', '/TN', path, '/ENABLE']);
  await runTask(io, path);
}

/** The spec the task runs: its recorded path, or where it would go now when the action cannot be read. */
const ownedSpecPath = (io: SchtasksIo, task: ParsedTask | undefined): string =>
  task?.action?.specPath ?? serviceSpecPath(io.localAppData);

/**
 * Another installer's service whose task action broke: the task is rebuilt from that owner's own spec, which stays
 * as it is, so ownership never moves. `/Create /F` leaves the task enabled.
 */
async function repairAction(io: SchtasksIo, path: string, specPath: string): Promise<void> {
  const exec = parseServiceSpec(io.readFile(specPath) ?? '')!.exec;
  await createTask(io, path, stageTaskXml(io, renderTaskXml({ sid: io.sid, exec, specPath })));
}

/**
 * A task whose recorded exec an upgrade since pruned would launch a deleted binary, and one naming another spec path
 * (or ours, gone or unreadable) would run obsolete settings or exit at once, so either is recreated from the unit; the unit is
 * resolved only then, so a sound task starts even when no binary resolves. Only a service owned the way
 * the resolved unit is gets refreshed: starting a package-manager-owned service from the desktop app must not
 * rewrite it and hand ownership over.
 */
async function refreshesStaleTask(io: SchtasksIo, task: ParsedTask): Promise<'keep' | 'reinstall' | 'repair-action'> {
  const specPath = serviceSpecPath(io.localAppData);
  const { action } = task;
  // Ownership is the spec the task runs, which may sit on an older LOCALAPPDATA or profile path.
  // The supervisor exits on a spec it cannot parse or whose exec is gone, so either is as stale as a missing spec.
  const current = parseServiceSpec(io.readFile(ownedSpecPath(io, task)) ?? '');
  const sound =
    action !== undefined &&
    io.exists(action.exec) &&
    action.specPath.toLowerCase() === specPath.toLowerCase() &&
    current !== undefined &&
    io.exists(current.exec);
  if (sound) return 'keep';
  const { spec } = await renderUnit(io);
  // Without a readable spec there is no ownership left to protect, and the task cannot run as it is.
  if (current === undefined || desktopOwned(current) === desktopOwned(parseServiceSpec(spec))) return 'reinstall';
  // Another owner's service: never rewrite its spec. Its own exec can still be relaunched; a gone one is theirs to fix,
  // and running the task as it is would report success while no proxy starts.
  if (io.exists(current.exec)) return 'repair-action';
  throw new CliExit(EXIT.unrecoverable, m['cli.service.external_task_unusable']({ path: taskPath(io.sid) }));
}

// Disabling makes the stop survive the next logon, which would otherwise start the task again.
export async function schtasksStop(io: SchtasksIo): Promise<void> {
  const path = taskPath(io.sid);
  // A task deleted by hand leaves its supervisor running: `/Delete` does not stop what the task started.
  const task = await ownTask(io, path);
  if (!task) {
    await endSupervisor(io, task);
    // With no task to disable, the uninstall marker is what keeps the desktop app from reinstalling the stopped
    // service; `service start` and `service install` clear it.
    io.writeFile(uninstallMarkerPath('win32', { LOCALAPPDATA: io.localAppData })!, '');
    return;
  }
  await endTask(io, path, task);
  await io.run(['schtasks', '/Change', '/TN', path, '/DISABLE']);
}

export async function schtasksRestart(io: SchtasksIo): Promise<void> {
  const path = taskPath(io.sid);
  const specPath = serviceSpecPath(io.localAppData);
  // The task may still name an older spec path (LOCALAPPDATA or the profile moved): a rollback restores that one.
  const previousTask = await ownTask(io, path);
  const previousSpecPath = previousTask?.action?.specPath ?? specPath;
  const previousSpec = io.readFile(previousSpecPath);
  const previousAtSpecPath = io.readFile(specPath);
  // Stage both files first, so a failed write leaves the running task untouched.
  const { spec, xml } = await renderUnit(io);
  const staged = `${specPath}.new`;
  io.writeFile(staged, spec);
  const file = stageTaskXml(io, xml);
  try {
    await endTask(io, path, previousTask);
  } catch (error) {
    // The old supervisor may still run its task: leave both untouched, only drop what was staged.
    io.remove(staged);
    io.remove(file);
    throw error;
  }
  try {
    // The spec moves in before `/Create /F` replaces the task (which leaves it enabled, undoing a `service stop`),
    // so a task is never registered against a spec that failed to land.
    io.rename(staged, specPath);
    await createTask(io, path, file);
    await runTask(io, path);
  } catch (error) {
    io.remove(staged);
    // Bring the previous definition back rather than leave the proxy offline. It is rendered from the spec the
    // previous task named (never from the queried XML), at the path that task named. Without a previous task
    // there is nothing to bring back: a task this restart created goes again.
    if (previousAtSpecPath === undefined) io.remove(specPath);
    else io.writeFile(specPath, previousAtSpecPath);
    if (previousTask === undefined) {
      await io.run(['schtasks', '/Delete', '/TN', path, '/F'], true);
      throw error;
    }
    try {
      const previousExec = previousSpec === undefined ? undefined : parseServiceSpec(previousSpec)?.exec;
      if (previousExec === undefined) throw new Error('no readable previous service spec');
      await createTask(
        io,
        path,
        stageTaskXml(io, renderTaskXml({ sid: io.sid, exec: previousExec, specPath: previousSpecPath })),
      );
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
 * Restart from inside the service. Ending the task would end our own supervisor (and, through its Job Object,
 * this process) before `/Run`, so instead refresh the spec (and the task when its `exec` or spec path moved) and exit with the
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
  // The running supervisor keeps the spec path it was started with and re-reads that file after the exit below;
  // a new task definition only takes effect at the next launch. So the supervisor's own spec gets the new unit too,
  // written first and put back if anything after it fails, so a failed restart changes nothing.
  let supervisorSpec: { path: string; previous: string | undefined } | undefined;
  let previousCurrent: { content: string | undefined } | undefined;
  try {
    // A failed query or a foreign task throws before anything is written: `/Create /F` would overwrite it.
    // The supervisor re-reads the spec the task names, so a stale spec path needs a new task as much as a moved exec.
    const action = (await ownTask(io, path))?.action;
    if (action !== undefined && action.specPath.toLowerCase() !== specPath.toLowerCase()) {
      supervisorSpec = { path: action.specPath, previous: io.readFile(action.specPath) };
      io.writeFile(action.specPath, spec);
    }
    const exec = parseServiceSpec(spec)?.exec;
    // The current spec moves in before `/Create /F` replaces the task, so the task is never left pointing at a spec
    // that a failed rename did not write; a failed create puts that spec back below.
    previousCurrent = { content: io.readFile(specPath) };
    io.rename(staged, specPath);
    if (!taskCurrent(action, exec, specPath)) await createTask(io, path, stageTaskXml(io, xml));
  } catch (error) {
    io.remove(staged);
    if (previousCurrent !== undefined) {
      if (previousCurrent.content === undefined) io.remove(specPath);
      else io.writeFile(specPath, previousCurrent.content);
    }
    if (supervisorSpec !== undefined) {
      if (supervisorSpec.previous === undefined) io.remove(supervisorSpec.path);
      else io.writeFile(supervisorSpec.path, supervisorSpec.previous);
    }
    throw error;
  }
  scheduleExit(EXIT.restartRequested, 1000);
}

/** The state file the task's supervisor writes: beside the spec the task names, which may be an older path. */
const supervisorStatePath = (io: SchtasksIo, task: ParsedTask | undefined): string =>
  task?.action ? serviceStatePathBeside(task.action.specPath) : serviceStatePath(io.localAppData);

/** Terminates the recorded supervisor when it still runs, then waits up to 10 s for it to be gone. */
async function endSupervisor(io: SchtasksIo, task: ParsedTask | undefined): Promise<void> {
  const state = parseSupervisorState(io.readFile(supervisorStatePath(io, task)));
  if (supervisorAlive(state, io.imagePath, io.creationTime)) {
    try {
      io.kill(state.pid);
    } catch {
      // It may have exited since the check (ESRCH): the wait below decides either way.
    }
  }
  const deadline = io.now() + SUPERVISOR_EXIT_TIMEOUT_MS;
  while (supervisorAlive(state, io.imagePath, io.creationTime)) {
    if (io.now() >= deadline) {
      throw new CliExit(
        EXIT.transient,
        m['cli.service.supervisor_timeout']({ seconds: SUPERVISOR_EXIT_TIMEOUT_MS / 1000 }),
      );
    }
    await io.sleep(SUPERVISOR_POLL_MS);
  }
}

// Ending the supervisor closes its Job Object, which takes the proxy with it; `/Delete` alone would leave both running.
export async function schtasksUninstall(io: SchtasksIo): Promise<void> {
  const path = taskPath(io.sid);
  const task = await ownTask(io, path);
  // With the task deleted by hand there is nothing for `/End` to stop, so end an orphaned supervisor ourselves.
  if (task) await endTask(io, path, task);
  else await endSupervisor(io, task);
  if (task) await io.run(['schtasks', '/Delete', '/TN', path, '/F']);
  io.remove(serviceSpecPath(io.localAppData));
  io.remove(serviceStatePath(io.localAppData));
  io.remove(supervisorStatePath(io, task));
  io.writeFile(uninstallMarkerPath('win32', { LOCALAPPDATA: io.localAppData })!, '');
}

/** Prints the task, then exits 0 only when the supervisor runs: a registered but stopped or disabled task is not active. */
export async function schtasksStatus(io: SchtasksIo): Promise<number> {
  const path = taskPath(io.sid);
  const code = await io.run(['schtasks', '/Query', '/TN', path, '/V', '/FO', 'LIST'], true);
  if (code !== 0) return code;
  // The supervisor writes its state beside the spec its task names, which may be an older path.
  const query = await queryTaskXml(io.capture, path);
  const task = query.kind === 'found' ? parseTaskXml(query.xml) : undefined;
  const state = parseSupervisorState(io.readFile(supervisorStatePath(io, task)));
  return supervisorAlive(state, io.imagePath, io.creationTime) ? 0 : EXIT.transient;
}
