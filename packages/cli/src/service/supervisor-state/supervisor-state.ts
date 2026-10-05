import { isPlainObject } from 'es-toolkit/predicate';

import { processCreationTime, processImagePath } from '../../win32-ffi';

/** What `__service-run` records in `service.state.json`: its PID, the image it runs from, and when it started
 * (`created`, a decimal FILETIME string). The start time tells it from a later process the OS gave the same PID. */
export type SupervisorState = { readonly pid: number; readonly exec: string; readonly created: string };

/** The state file's content; undefined when it holds no usable record (missing, malformed, or without `exec`/`created`). */
export function parseSupervisorState(text: string | undefined): SupervisorState | undefined {
  try {
    const state: unknown = JSON.parse(text ?? '');
    if (!isPlainObject(state)) return undefined;
    const { pid, exec, created } = state;
    return typeof pid === 'number' &&
      Number.isInteger(pid) &&
      pid > 0 &&
      typeof exec === 'string' &&
      exec !== '' &&
      typeof created === 'string' &&
      created !== ''
      ? { pid, exec, created }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the recorded supervisor still runs: the process at its PID runs the image it recorded and started when it did. The image is
 * the supervisor's own, not the current spec's `exec`, which an in-service restart may have moved since. A PID
 * the OS has handed to another program is not the supervisor, and neither is a record without `exec`/`created`.
 */
export function supervisorAlive(
  state: SupervisorState | undefined,
  imagePath: (pid: number) => string | undefined = processImagePath,
  creationTime: (pid: number) => string | undefined = processCreationTime,
): state is SupervisorState {
  return (
    state !== undefined &&
    imagePath(state.pid)?.toLowerCase() === state.exec.toLowerCase() &&
    creationTime(state.pid) === state.created
  );
}
