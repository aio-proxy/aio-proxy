import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, win32 } from 'node:path';

import { systemdUnitPath } from '../systemd';

/**
 * Left by `service uninstall` where the unit lived, independent of `AIO_PROXY_HOME`, so discovery can tell
 * "the user removed the service" from "never installed". macOS keeps launchd's own disabled override instead.
 */
export function uninstallMarkerPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  if (platform === 'linux') return `${systemdUnitPath(env)}.uninstalled`;
  const localAppData = env['LOCALAPPDATA'];
  if (platform === 'win32' && localAppData !== undefined && localAppData !== '') {
    return win32.join(localAppData, 'aio-proxy', 'service.uninstalled');
  }
  return undefined;
}

export function writeUninstallMarker(platform: NodeJS.Platform = process.platform, env = process.env): void {
  const path = uninstallMarkerPath(platform, env);
  if (path === undefined) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
}

export function clearUninstallMarker(platform: NodeJS.Platform = process.platform, env = process.env): void {
  const path = uninstallMarkerPath(platform, env);
  if (path !== undefined) rmSync(path, { force: true });
}

export function uninstallMarkerExists(platform: NodeJS.Platform = process.platform, env = process.env): boolean {
  const path = uninstallMarkerPath(platform, env);
  return path !== undefined && existsSync(path);
}
