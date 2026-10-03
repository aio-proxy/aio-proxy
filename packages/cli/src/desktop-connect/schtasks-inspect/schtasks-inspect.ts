import { queryTaskXml, type TaskQuery, windowsLocalAppData } from '../../service/schtasks';
import {
  isOwnTask,
  parseServiceSpec,
  parseTaskXml,
  serviceStatePathBeside,
  taskPath,
  type WindowsUser,
} from '../../service/schtasks-unit';
import { parseSupervisorState, supervisorAlive } from '../../service/supervisor-state';
import { uninstallMarkerExists } from '../../service/uninstall-marker';
import type { JobState, UnitInspection } from '../launchd-inspect';
import type { Run } from '../sockets';

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
    action.exec.toLowerCase() === service.exec.toLowerCase() &&
    action.specPath.toLowerCase() === specPath.toLowerCase();
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
  readonly creationTime: (pid: number) => string | undefined;
  /** This process's account SID; empty when it could not be read. */
  readonly owner: string;
  readonly sidForAccount: (account: string) => string | undefined;
};

const NO_UNIT: UnitInspection = { present: false, wrapperValid: false, target: null, home: null };

/** The unit and job together: both hang off the one task query. Any failure is unknown and disabled. */
export async function readTask(deps: TaskProbeDeps): Promise<{ unit: UnitInspection; job: JobState }> {
  const capture = async (cmd: readonly string[]) => ({ ...(await deps.run(cmd)), stderr: '' });
  const read = (path: string) => deps.readFile(path).catch(() => undefined);
  try {
    windowsLocalAppData(deps.env); // throws, and so reads as unknown, without LOCALAPPDATA
    if (deps.owner === '') throw new Error('no account SID');
    const user = { sid: deps.owner, sidForAccount: deps.sidForAccount };
    const query = await queryTaskXml(capture, taskPath(user.sid));
    const xml = query.kind === 'found' ? query.xml : undefined;
    // A task left on an older LOCALAPPDATA or profile still names the spec its supervisor runs, and the
    // supervisor's state sits beside that spec: both are read where the task points, not where they would go now.
    const specPath = (xml === undefined ? undefined : parseTaskXml(xml)?.action?.specPath) ?? deps.unitPath;
    const unit = query.kind === 'missing' ? NO_UNIT : inspectTask(xml, await read(specPath), user, specPath);
    const state = parseSupervisorState(await read(serviceStatePathBeside(specPath)));
    const markerExists = uninstallMarkerExists('win32', deps.env);
    return {
      unit,
      job: taskJob(query, markerExists, supervisorAlive(state, deps.imagePath, deps.creationTime) ? state.pid : null),
    };
  } catch {
    return {
      unit: { present: true, wrapperValid: false, target: null, home: null },
      job: { loaded: false, disabled: true, pid: null },
    };
  }
}
