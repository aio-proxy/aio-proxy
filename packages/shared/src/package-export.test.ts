import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('package root resolves to the built entry', () => {
  const resolved = fileURLToPath(import.meta.resolve('@aio-proxy/shared'));
  expect(resolved).toEndWith(join('packages', 'shared', 'dist', 'index.js'));
});
