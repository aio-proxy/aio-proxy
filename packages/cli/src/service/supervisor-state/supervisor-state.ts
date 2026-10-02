import { isPlainObject } from 'es-toolkit/predicate';

import { processImagePath } from '../../win32-ffi';

/** What `__service-run` records in `service.state.json`: its PID and the image it runs from. */
export type SupervisorState = { readonly pid: number; readonly exec: string };

/** The state file's content; undefined when it holds no usable record (missing, malformed, or without `exec`). */
export function parseSupervisorState(text: string | undefined): SupervisorState | undefined {
  try {
    const state: unknown = JSON.parse(text ?? '');
    if (!isPlainObject(state)) return undefined;
    const { pid, exec } = state;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && typeof exec === 'string' && exec !== ''
      ? { pid, exec }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the recorded supervisor still runs: the process at its PID runs the image it recorded. The image is
 * the supervisor's own, not the current spec's `exec`, which an in-service restart may have moved since. A PID
 * the OS has handed to another program is not the supervisor, and neither is a record without `exec`.
 */
export function supervisorAlive(
  state: SupervisorState | undefined,
  imagePath: (pid: number) => string | undefined = processImagePath,
): state is SupervisorState {
  return state !== undefined && imagePath(state.pid)?.toLowerCase() === state.exec.toLowerCase();
}
