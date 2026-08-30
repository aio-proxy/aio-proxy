import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('built package entry resolves isRecord', async () => {
  const resolved = fileURLToPath(import.meta.resolve('@aio-proxy/shared'));
  expect(resolved).toEndWith(join('packages', 'shared', 'dist', 'index.js'));

  const built = await import(join(import.meta.dir, '../dist/index.js'));
  expect(typeof built.isRecord).toBe('function');
  expect(built.isRecord({})).toBe(true);
  expect(built.isRecord([])).toBe(false);
});
