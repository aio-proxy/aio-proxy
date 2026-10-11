import { existsSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';

import { isPlainObject } from 'es-toolkit/predicate';

import { launchdPlistPath } from './launchd';
import { parseServiceSpec, serviceSpecPath } from './schtasks-unit';
import { parseSystemdUnit, systemdUnitPath } from './systemd';

export function managedUnitPath(os: NodeJS.Platform = platform()): string | undefined {
  if (os === 'darwin') return launchdPlistPath();
  if (os === 'linux') return systemdUnitPath();
  const localAppData = process.env['LOCALAPPDATA'];
  if (os === 'win32' && localAppData !== undefined && localAppData !== '') return serviceSpecPath(localAppData);
  return undefined;
}

/**
 * Whether the installed plist belongs to the desktop app: its wrapper target is the symlink the app
 * recorded as `AIO_PROXY_DESKTOP_EXEC` (writeManagedUnit writes both only for a desktop-owned unit,
 * and a CLI rewrite replaces both). Any read or parse failure answers false, which keeps today's behavior.
 */
export function readDesktopOwnedUnit(path?: string, os: NodeJS.Platform = process.platform): boolean {
  const file = path ?? managedUnitPath(os);
  if (file === undefined || !existsSync(file)) return false;
  if (os === 'linux' || os === 'win32') {
    // Same rule as darwin: the unit's program is the symlink the app recorded in its own environment.
    try {
      const text = readFileSync(file, 'utf8');
      const unit = os === 'linux' ? parseSystemdUnit(text) : parseServiceSpec(text);
      const marker = unit?.env['AIO_PROXY_DESKTOP_EXEC'];
      return marker !== undefined && marker !== '' && marker === unit?.exec;
    } catch {
      return false;
    }
  }
  if (os !== 'darwin') return false;
  const converted = Bun.spawnSync(['plutil', '-convert', 'json', '-o', '-', file], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (converted.exitCode !== 0) return false;
  try {
    const plist: unknown = JSON.parse(converted.stdout.toString());
    if (!isPlainObject(plist)) return false;
    const env = plist['EnvironmentVariables'];
    const args = plist['ProgramArguments'];
    const marker = isPlainObject(env) ? env['AIO_PROXY_DESKTOP_EXEC'] : undefined;
    return typeof marker === 'string' && marker !== '' && Array.isArray(args) && args[3] === marker;
  } catch {
    return false;
  }
}

// Whether a managed unit file exists for the current platform. Callers that only
// want to restart a managed daemon should gate on this first, since a manually
// started daemon (`aio-proxy run`) has no installed unit. Returns false on
// unsupported platforms rather than throwing, since "no managed service" is the
// honest answer there too.
export function isManagedServiceInstalled(): boolean {
  const unit = managedUnitPath();
  return unit !== undefined && existsSync(unit);
}
