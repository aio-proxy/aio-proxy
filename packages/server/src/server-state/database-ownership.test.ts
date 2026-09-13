import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSyncRepository } from '@aio-proxy/core';
import { DatabaseOwnershipError, openDb, resolveDbPath } from '@aio-proxy/core/db';
import { definePlugin, zod } from '@aio-proxy/plugin-sdk';
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

test('startup unwinding awaits disposal of a bound backend', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-server-sync-unwind-'));
  const configPath = join(home, 'config.json');
  const config = ConfigSchema.parse({ plugins: ['@example/sync'], providers: {} });
  writeFileSync(configPath, JSON.stringify(config));
  const database = openDb({ home });
  createSyncRepository(database.sqlite).writeBinding({
    id: 'binding',
    plugin: '@example/sync',
    capability: 'memory',
    pluginVersion: '1.0.0',
    identityId: 'identity',
    spaceId: 'default',
    deviceId: 'device',
    sessionGeneration: 1,
    options: {},
    // Seeded directly rather than through a connect: this is an established binding whose reviewed
    // Apply already completed, so startup may bind it.
    connectPending: false,
  });
  database.close();

  const events: string[] = [];
  let signalDisposeStarted!: () => void;
  const disposeStarted = new Promise<void>((resolve) => {
    signalDisposeStarted = resolve;
  });
  let releaseDispose!: () => void;
  const disposeGate = new Promise<void>((resolve) => {
    releaseDispose = resolve;
  });
  const descriptor = definePlugin((api) => {
    api.sync.register({
      id: 'memory',
      displayName: 'Memory',
      options: { schema: zod.object({}), form: [] },
      async connect() {
        events.push('connected');
        return {
          identityId: 'identity',
          spaceId: 'default' as const,
          maxValueBytes: 1_000_000,
          async read() {
            return { kind: 'absent' as const };
          },
          async compareAndSwap() {
            return { kind: 'conflict' as const };
          },
          async list() {
            return { keys: [] };
          },
          async remove() {
            return { kind: 'conflict' as const };
          },
          async dispose() {
            events.push('dispose-started');
            signalDisposeStarted();
            await disposeGate;
            events.push('disposed');
          },
        };
      },
    });
  });

  const attempt = createServerState({
    config,
    configPath,
    dbHome: home,
    builtIns: [{ packageName: '@example/sync', version: '1.0.0', descriptor }],
    __test: { failStartupAfter: 'login_sessions' },
  } satisfies InternalServerStateOptions);
  await disposeStarted;
  expect(events).toEqual(['connected', 'dispose-started']);
  releaseDispose();
  await expect(attempt).rejects.toThrow('injected startup failure: login_sessions');
  expect(events).toEqual(['connected', 'dispose-started', 'disposed']);
  expect(existsSync(`${resolveDbPath({ home })}.server.lock`)).toBe(false);
});
