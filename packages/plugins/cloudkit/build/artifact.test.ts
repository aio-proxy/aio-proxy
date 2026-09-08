import { expect, test } from 'bun:test';

import { nativeArchivePath } from '../scripts/pack-native';

test('the package exposes the lazy CloudKit descriptor entry point', async () => {
  const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json();
  expect(packageJson.name).toBe('@aio-proxy/plugin-cloudkit');
  expect(packageJson.private).toBeUndefined();
  expect(packageJson.exports['.'].default).toBe('./dist/index.js');
  expect(nativeArchivePath('CloudKit.app.zip')).toBe('dist/native/CloudKit.app.zip');
});
