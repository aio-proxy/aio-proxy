import { parseSystemdUnit } from '../../service/systemd';
import { uninstallMarkerExists } from '../../service/uninstall-marker';
import { SYSTEMD_UNIT_NAME } from '../../service/unit-templates';
import type { JobState, UnitInspection } from '../launchd-inspect';
import type { Run } from '../sockets';

// The one ExecStart line `renderSystemdUnit` writes: a quoted program followed by `run`.
const EXEC_START = /^ExecStart="(?:[^"\\]|\\.)*" run$/mu;

export function inspectSystemdUnit(text: string): UnitInspection {
  const { exec, env } = parseSystemdUnit(text);
  const wrapperValid = exec !== null && EXEC_START.test(text);
  return { present: true, wrapperValid, target: wrapperValid ? exec : null, home: env['AIO_PROXY_HOME'] ?? null };
}

/** `systemctl --user show -p LoadState,ActiveState,UnitFileState,MainPID` output; anything unreadable is disabled. */
export function parseSystemctlShow(stdout: string, code: number, markerExists: boolean): JobState {
  const props = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  const load = props.get('LoadState');
  if (code !== 0 || load === undefined) return { loaded: false, disabled: true, pid: null };
  // No unit at all: a first run, unless the user uninstalled the service.
  if (load === 'not-found') return { loaded: false, disabled: markerExists, pid: null };
  const pid = Number(props.get('MainPID'));
  return {
    loaded: load === 'loaded',
    disabled: props.get('UnitFileState') !== 'enabled',
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
  };
}

type SystemdProbeDeps = {
  readonly env: NodeJS.ProcessEnv;
  readonly unitPath: string;
  readonly unitExists: () => boolean;
  readonly run: Run;
  readonly readFile: (path: string) => Promise<string>;
};

const UNREADABLE: UnitInspection = { present: true, wrapperValid: false, target: null, home: null };
const NO_UNIT: UnitInspection = { present: false, wrapperValid: false, target: null, home: null };

export async function readSystemdUnit(deps: SystemdProbeDeps): Promise<UnitInspection> {
  if (!deps.unitExists()) return NO_UNIT;
  try {
    return inspectSystemdUnit(await deps.readFile(deps.unitPath));
  } catch {
    return UNREADABLE;
  }
}

export async function readSystemdJob(deps: SystemdProbeDeps): Promise<JobState> {
  try {
    const props = 'LoadState,ActiveState,UnitFileState,MainPID';
    const { code, stdout } = await deps.run(['systemctl', '--user', 'show', SYSTEMD_UNIT_NAME, '-p', props]);
    return parseSystemctlShow(stdout, code, uninstallMarkerExists('linux', deps.env));
  } catch {
    return { loaded: false, disabled: true, pid: null };
  }
}
