import { expect, test } from 'bun:test';

import { trustedComment } from '../minisign';
import { assetName, checkRehearsalEnv, packagerConfig, withVersion } from './package';

test('asset names follow the release contract', () => {
  expect(assetName('linux-x86_64', '0.40.0')).toBe('aio-proxy-0.40.0-x86_64.AppImage');
  expect(assetName('linux-aarch64', '0.40.0')).toBe('aio-proxy-0.40.0-aarch64.AppImage');
  expect(assetName('windows-x86_64', '0.40.0')).toBe('aio-proxy-0.40.0-x64-setup.exe');
  expect(assetName('windows-x86_64', '0.40.0', true)).toBe('aio-proxy-0.40.0-x64-setup-rehearsal.exe');
  // Every name must also be one the updater's signed trusted comment accepts.
  expect(() => trustedComment('0.40.0', 'linux-aarch64', assetName('linux-aarch64', '0.40.0', true))).not.toThrow();
  expect(() => assetName('darwin-arm64', '0.40.0')).toThrow();
});

test('override variables are allowed only in a rehearsal', () => {
  expect(() => checkRehearsalEnv({ AIO_PROXY_DESKTOP_FEED_URL: 'http://127.0.0.1/latest.json' }, false)).toThrow();
  expect(() => checkRehearsalEnv({ AIO_PROXY_DESKTOP_UPDATE_KEY: 'x' }, false)).toThrow();
  // option_env! bakes in an empty value too.
  expect(() => checkRehearsalEnv({ AIO_PROXY_DESKTOP_UPDATE_KEY: '' }, false)).toThrow();
  expect(() => checkRehearsalEnv({ AIO_PROXY_DESKTOP_FEED_URL: 'http://127.0.0.1/latest.json' }, true)).not.toThrow();
  expect(() => checkRehearsalEnv({}, false)).not.toThrow();
});

test('the packager config carries the release version and the sign command only when configured', () => {
  expect(packagerConfig('0.40.0', {})).toEqual({ version: '0.40.0' });
  expect(packagerConfig('0.40.0', { WINDOWS_SIGN_COMMAND: 'signtool sign %1' })).toEqual({
    version: '0.40.0',
    signCommand: 'signtool sign %1',
  });
});

test('the build version replaces only the top-level package version', () => {
  const manifest = '{\n  "name": "aio-proxy",\n  "version": "0.38.0",\n  "deps": { "x": { "version": "1.0.0" } }\n}\n';
  expect(withVersion(manifest, '0.0.1')).toBe(manifest.replace('"0.38.0"', '"0.0.1"'));
  expect(() => withVersion('{ "name": "x" }', '0.0.1')).toThrow();
});
