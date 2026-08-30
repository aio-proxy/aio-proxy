import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('built package entry resolves isObject', async () => {
  const resolved = fileURLToPath(import.meta.resolve('@aio-proxy/shared'));
  expect(resolved).toEndWith(join('packages', 'shared', 'dist', 'index.js'));

  const built = await import(join(import.meta.dir, '../dist/index.js'));
  expect(typeof built.isObject).toBe('function');
  expect(built.isObject({})).toBe(true);
  expect(built.isObject([])).toBe(false);
});
