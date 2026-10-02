import { currentUser, queryTaskXml, type TaskQuery, windowsLocalAppData } from '../../service/schtasks';
import {
  isOwnTask,
  parseServiceSpec,
  parseTaskXml,
  serviceStatePath,
  taskPath,
  type WindowsUser,
} from '../../service/schtasks-unit';
import { parseSupervisorState, supervisorAlive } from '../../service/supervisor-state';
import { uninstallMarkerExists } from '../../service/uninstall-marker';
import type { JobState, UnitInspection } from '../launchd-inspect';
import type { Run } from '../sockets';

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
  const action = task?.action;
  const service = spec === undefined ? undefined : parseServiceSpec(spec);
  const wrapperValid =
    action !== undefined &&
    service !== undefined &&
    isOwnTask(task, user) &&
    asciiFolded(action.exec) === asciiFolded(service.exec) &&
    asciiFolded(action.specPath) === asciiFolded(specPath);
  return {
    present: true,
    wrapperValid,
    target: wrapperValid ? service.exec : null,
    home: service?.env['AIO_PROXY_HOME'] ?? null,
  };
}

/** `supervisorPid` is the running supervisor's PID from `service.state.json`, or null when none runs. */
export function taskJob(query: TaskQuery, markerExists: boolean, supervisorPid: number | null): JobState {
  // No task at all: a first run, unless the user uninstalled the service.
  if (query.kind === 'missing') return { loaded: false, disabled: markerExists, pid: null };
  if (query.kind === 'failed') return { loaded: false, disabled: true, pid: null };
  // An unreadable task is not enabled.
  const disabled = parseTaskXml(query.xml)?.enabled !== true;
  return { loaded: !disabled, disabled, pid: supervisorPid };
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
    const state = parseSupervisorState(await read(serviceStatePath(localAppData)));
    const markerExists = uninstallMarkerExists('win32', deps.env);
    return { unit, job: taskJob(query, markerExists, supervisorAlive(state, deps.imagePath) ? state.pid : null) };
  } catch {
    return {
      unit: { present: true, wrapperValid: false, target: null, home: null },
      job: { loaded: false, disabled: true, pid: null },
    };
  }
}
