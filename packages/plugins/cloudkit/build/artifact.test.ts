import { expect, test } from 'bun:test';

test('the package exposes the lazy CloudKit descriptor entry point', async () => {
  const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json();
  expect(packageJson.name).toBe('@aio-proxy/plugin-cloudkit');
  expect(packageJson.private).toBeUndefined();
  expect(packageJson.exports['.'].default).toBe('./dist/index.js');
});
