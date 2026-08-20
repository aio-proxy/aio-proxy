import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatabaseOwnershipError, resolveDbPath } from '@aio-proxy/core/db';
import { ConfigSchema } from '@aio-proxy/types';

import { createServerState } from './index';
import type { InternalServerStateOptions } from './types';

test('normal close and initialization failure both release database ownership immediately', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-server-owner-'));
  const failing = {
    config: ConfigSchema.parse({ providers: {} }),
    dbHome: home,
    __test: {
      createRouter: () => {
        throw new Error('injected initialization failure');
      },
    },
  } satisfies InternalServerStateOptions;
  await expect(createServerState(failing)).rejects.toThrow('injected initialization failure');

  const first = await createServerState({
    config: failing.config,
    dbHome: home,
    providerInstances: [],
  });
  await expect(
    createServerState({
      config: failing.config,
      dbHome: home,
      providerInstances: [],
    }),
  ).rejects.toBeInstanceOf(DatabaseOwnershipError);
  first.close();

  const restarted = await createServerState({
    config: failing.config,
    dbHome: home,
    providerInstances: [],
  });
  restarted.close();
});

test('a failed first start in a missing nested dbHome leaves no live ownership generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-proxy-server-new-owner-'));
  const home = join(root, 'nested', 'db-home');
  const config = ConfigSchema.parse({ providers: {} });
  await expect(
    createServerState({
      config,
      dbHome: home,
      __test: {
        createRouter: () => {
          throw new Error('injected first-start failure');
        },
      },
    } satisfies InternalServerStateOptions),
  ).rejects.toThrow('injected first-start failure');
  const databasePath = resolveDbPath({ home });
  expect(existsSync(`${databasePath}.server.lock`)).toBe(false);
  const restarted = await createServerState({ config, dbHome: home, providerInstances: [] });
  restarted.close();
});

test.each(['scheduler', 'recovery', 'login_sessions', 'watcher'] as const)(
  'failure after %s unwinds startup resources and permits immediate restart',
  async (failStartupAfter) => {
    const home = mkdtempSync(join(tmpdir(), 'aio-proxy-server-startup-unwind-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ providers: {} }));
    const config = ConfigSchema.parse({ providers: {} });
    await expect(
      createServerState({
        config,
        configPath,
        dbHome: home,
        __test: { failStartupAfter },
      } satisfies InternalServerStateOptions),
    ).rejects.toThrow(`injected startup failure: ${failStartupAfter}`);
    expect(existsSync(`${resolveDbPath({ home })}.server.lock`)).toBe(false);
    const restarted = await createServerState({ config, configPath, dbHome: home, providerInstances: [] });
    restarted.close();
  },
);
