import { accessSync, constants, statSync } from 'node:fs';

import { isPlainObject } from 'es-toolkit/predicate';

import { LAUNCHD_EXEC_WRAPPER, LAUNCHD_LABEL, LEGACY_LAUNCHD_EXEC_WRAPPERS } from '../service';

export type UnitInspection = {
  readonly present: boolean;
  readonly wrapperValid: boolean;
  readonly target: string | null;
  readonly home: string | null;
};

const KNOWN_WRAPPERS = new Set([LAUNCHD_EXEC_WRAPPER, ...LEGACY_LAUNCHD_EXEC_WRAPPERS]);

/** `plist` is `plutil -convert json` output. ProgramArguments[0] is /bin/sh; the aio-proxy path is the fourth element. */
export function inspectUnit(plist: unknown): UnitInspection {
  if (!isPlainObject(plist)) return { present: true, wrapperValid: false, target: null, home: null };
  const args = plist['ProgramArguments'];
  const env = plist['EnvironmentVariables'];
  const home = isPlainObject(env) && typeof env['AIO_PROXY_HOME'] === 'string' ? env['AIO_PROXY_HOME'] : null;
  const wrapperValid =
    Array.isArray(args) &&
    args.length === 4 &&
    args[0] === '/bin/sh' &&
    args[1] === '-c' &&
    typeof args[2] === 'string' &&
    KNOWN_WRAPPERS.has(args[2]) &&
    typeof args[3] === 'string';
  return { present: true, wrapperValid, target: wrapperValid ? (args[3] as string) : null, home };
}

export type UnitOwner = 'desktop' | 'external' | 'orphaned' | 'unknown' | null;

/** What the wrapper's `[ -x "$0" ]` lets launchd run: an executable regular file. */
export function isRunnable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * `orphaned` is an external unit whose target cannot run: the CLI that installed it was removed
 * (`brew uninstall` leaves the plist behind) or lost its execute bit, so launchd can only fail
 * to start it.
 */
export function unitOwner(
  unit: UnitInspection,
  desktopExec: string | undefined,
  targetRunnable: (path: string) => boolean,
): UnitOwner {
  if (!unit.present) return null;
  if (!unit.wrapperValid || unit.target === null) return 'unknown';
  if (desktopExec !== undefined && desktopExec !== '' && unit.target === desktopExec) return 'desktop';
  return targetRunnable(unit.target) ? 'external' : 'orphaned';
}

export function parseJobPrint(code: number, stdout: string): { readonly loaded: boolean; readonly pid: number | null } {
  if (code !== 0) return { loaded: false, pid: null };
  const match = /^\s*pid = (\d+)\s*$/mu.exec(stdout);
  return { loaded: true, pid: match === null ? null : Number(match[1]) };
}

export function parseDisabled(stdout: string): boolean {
  const match = new RegExp(`"${LAUNCHD_LABEL.replaceAll('.', '\\.')}" => (\\w+)`, 'u').exec(stdout);
  return match?.[1] === 'disabled' || match?.[1] === 'true';
}
