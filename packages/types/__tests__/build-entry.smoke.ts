import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('built package entry resolves the colocated dashboard contract', async () => {
  const entry = join(import.meta.dir, '../dist/index.js');
  const built = await import(entry);

  expect(built.DashboardOverviewResponseSchema).toBeDefined();
});
