import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from './server';

test('createServer exposes idempotent close and route-assembly failure closes state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-app-close-'));
  const first = await createServer({ config: { providers: {} }, dbHome: home });
  first.close();
  first.close();
  const second = await createServer({ config: { providers: {} }, dbHome: home });
  second.close();

  await expect(
    createServer({
      config: { providers: {} },
      dbHome: home,
      __test: {
        createRoutes: () => {
          throw new Error('injected route assembly failure');
        },
      },
    }),
  ).rejects.toThrow('injected route assembly failure');
  const afterFailure = await createServer({ config: { providers: {} }, dbHome: home });
  afterFailure.close();
});
