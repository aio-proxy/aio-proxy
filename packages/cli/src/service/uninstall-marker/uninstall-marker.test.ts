import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearUninstallMarker,
  uninstallMarkerExists,
  uninstallMarkerPath,
  writeUninstallMarker,
} from './uninstall-marker';

test('the Linux marker sits beside the systemd user unit whatever AIO_PROXY_HOME is', () => {
  const env = { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'aio-marker-')), AIO_PROXY_HOME: '/elsewhere' };
  expect(uninstallMarkerPath('linux', env)).toBe(
    join(env.XDG_CONFIG_HOME, 'systemd', 'user', 'aio-proxy.service.uninstalled'),
  );
  expect(uninstallMarkerExists('linux', env)).toBe(false);
  writeUninstallMarker('linux', env);
  expect(uninstallMarkerExists('linux', env)).toBe(true);
  clearUninstallMarker('linux', env);
  expect(uninstallMarkerExists('linux', env)).toBe(false);
});

test('the Windows marker lives under LocalAppData, and macOS has none', () => {
  expect(uninstallMarkerPath('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' })).toBe(
    'C:\\Users\\a\\AppData\\Local\\aio-proxy\\service.uninstalled',
  );
  expect(uninstallMarkerPath('win32', {})).toBeUndefined();
  expect(uninstallMarkerPath('darwin', {})).toBeUndefined();
  expect(uninstallMarkerExists('darwin', {})).toBe(false);
});
