import { isPlainObject } from 'es-toolkit/predicate';

import { currentUser, queryTaskXml, type TaskQuery, windowsLocalAppData } from '../../service/schtasks';
import {
  parseServiceSpec,
  parseServiceState,
  parseTaskXml,
  serviceStatePath,
  taskPath,
} from '../../service/schtasks-unit';
import { uninstallMarkerExists } from '../../service/uninstall-marker';
import { processImagePath } from '../../win32-ffi';
import type { JobState, UnitInspection } from '../launchd-inspect';
import type { Run } from '../sockets';

export type WindowsUser = { readonly sid: string; readonly account: string };

// `schtasks /Query /XML` output reaches us in an unverified encoding, so non-ASCII path text from it may
// come back mangled (U+FFFD or another code page). Only its ASCII characters are compared.
const asciiFolded = (text: string): string => text.replace(/[\u0080-\u{10FFFF}]/gu, '').toLowerCase();

/**
 * The task is ours only when its principal is this user and it runs `<exec> __service-run <spec>` for the
 * spec file it should. `target` and `home` come from the spec, whose text is exact, never from the XML.
 */
export function inspectTask(
  xml: string | undefined,
  spec: string | undefined,
  user: WindowsUser,
  specPath: string,
): UnitInspection {
  const task = xml === undefined ? undefined : parseTaskXml(xml);
  const service = spec === undefined ? undefined : parseServiceSpec(spec);
  // Task Scheduler may name a user by SID or by account, and spell the principal and the trigger apart.
  const isUser = (id: string) => [user.sid, user.account].some((name) => name.toLowerCase() === id.toLowerCase());
  const wrapperValid =
    task !== undefined &&
    service !== undefined &&
    isUser(task.sid) &&
    (task.triggerUser === undefined || isUser(task.triggerUser)) &&
    asciiFolded(task.exec) === asciiFolded(service.exec) &&
    asciiFolded(task.specPath) === asciiFolded(specPath);
  return {
    present: true,
    wrapperValid,
    target: wrapperValid ? service.exec : null,
    home: service?.env['AIO_PROXY_HOME'] ?? null,
  };
}

/** Whether `pid` runs `exec`, by its full image path: another `aio-proxy.exe` elsewhere is not the job. */
export function pidAliveAs(
  pid: number,
  exec: string,
  imagePath: (pid: number) => string | undefined = processImagePath,
): boolean {
  return imagePath(pid)?.toLowerCase() === exec.toLowerCase();
}

// `Settings/Enabled` is what `/Change /DISABLE` flips. It is ASCII, so encoding-safe, unlike the localized
// status column of `schtasks /Query /V /FO CSV`. Absent means enabled; an unreadable task is not.
function taskEnabled(xml: string): boolean {
  try {
    const task = (Bun.XML.parse(xml) as Record<string, unknown>)['Task'];
    const settings = isPlainObject(task) ? task['Settings'] : undefined;
    if (!isPlainObject(settings)) return false;
    return settings['Enabled'] === undefined || settings['Enabled'] === 'true';
  } catch {
    return false;
  }
}

/** `statePid` is the supervisor's PID from `service.state.json`; it is the job only while it runs `exec`. */
export function taskJob(
  query: TaskQuery,
  markerExists: boolean,
  statePid: number | undefined,
  exec: string | null,
  alive: (pid: number, exec: string) => boolean,
): JobState {
  // No task at all: a first run, unless the user uninstalled the service.
  if (query.kind === 'missing') return { loaded: false, disabled: markerExists, pid: null };
  if (query.kind === 'failed') return { loaded: false, disabled: true, pid: null };
  const disabled = !taskEnabled(query.xml);
  const pid = statePid !== undefined && exec !== null && alive(statePid, exec) ? statePid : null;
  return { loaded: !disabled, disabled, pid };
}

type TaskProbeDeps = {
  readonly env: NodeJS.ProcessEnv;
  /** `service.json`, the Windows counterpart of the unit file. */
  readonly unitPath: string;
  readonly run: Run;
  readonly readFile: (path: string) => Promise<string>;
  readonly imagePath: (pid: number) => string | undefined;
};

const NO_UNIT: UnitInspection = { present: false, wrapperValid: false, target: null, home: null };

/** The unit and job together: both hang off the one task query. Any failure is unknown and disabled. */
export async function readTask(deps: TaskProbeDeps): Promise<{ unit: UnitInspection; job: JobState }> {
  const capture = async (cmd: readonly string[]) => ({ ...(await deps.run(cmd)), stderr: '' });
  const read = (path: string) => deps.readFile(path).catch(() => undefined);
  try {
    const localAppData = windowsLocalAppData(deps.env);
    const user = await currentUser(capture);
    const query = await queryTaskXml(capture, taskPath(user.sid));
    const unit =
      query.kind === 'missing'
        ? NO_UNIT
        : inspectTask(query.kind === 'found' ? query.xml : undefined, await read(deps.unitPath), user, deps.unitPath);
    const statePid = parseServiceState((await read(serviceStatePath(localAppData))) ?? '');
    const markerExists = uninstallMarkerExists('win32', deps.env);
    const alive = (pid: number, exec: string) => pidAliveAs(pid, exec, deps.imagePath);
    return { unit, job: taskJob(query, markerExists, statePid, unit.target, alive) };
  } catch {
    return {
      unit: { present: true, wrapperValid: false, target: null, home: null },
      job: { loaded: false, disabled: true, pid: null },
    };
  }
}
