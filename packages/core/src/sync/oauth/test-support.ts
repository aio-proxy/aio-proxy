import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type OAuthAdapter, zod } from '@aio-proxy/plugin-sdk';

import { openDb } from '../../db';
import { accountKey, encode } from '../protocol';
import { createSyncObjectStore } from '../publication';
import { createSyncRepository, type LocalBinding, type SyncRepository } from '../repository';
import { createMemorySyncBackend, type MemorySyncBackend } from '../test-support';
import {
  createSharedOAuthCoordinator,
  type SharedOAuthCoordinator,
  type SharedRefreshInput,
  type SharedRefreshResult,
} from './coordinator';
import type { LiveAccount } from './protocol';

const catalog = { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] } as const;

export function oauthAdapterFixture(overrides: Partial<OAuthAdapter> = {}): OAuthAdapter {
  return {
    id: 'test-capability',
    displayName: 'Test OAuth',
    account: { options: { schema: zod.object({}), form: [] } },
    credentials: zod.object({ token: zod.string() }),
    async login() {
      throw new Error('fixture login must not be called');
    },
    catalog: {
      policy: { kind: 'static' },
      async discover() {
        return catalog;
      },
    },
    async createRuntime() {
      throw new Error('fixture runtime must not be called');
    },
    ...overrides,
  };
}

export function liveAccountFixture(overrides: Partial<LiveAccount> = {}): LiveAccount {
  return {
    protocol: 1,
    objectId: '00000000-0000-4000-8000-000000000001',
    epoch: 0,
    plugin: '@fixture/oauth',
    capability: 'test-capability',
    pluginVersion: '1.0.0',
    formatVersion: 1,
    generation: 0,
    phase: 'ready',
    payload: { credential: { token: 'old' }, options: {}, secrets: {}, fingerprint: 'fixture' },
    claim: null,
    lastCompletedOperationId: null,
    ...overrides,
  };
}

export type SharedOAuthDevices = {
  readonly a: SharedOAuthCoordinator;
  readonly b: SharedOAuthCoordinator;
  readonly objectId: string;
  readonly schema: ReturnType<typeof zod.object>;
  readonly signal: AbortSignal;
  readonly backend: MemorySyncBackend;
  readonly repoA: SyncRepository;
  readonly repoB: SyncRepository;
  readonly injectAfterExchange: (callback: () => void) => void;
};

function binding(deviceId: string): LocalBinding {
  return {
    id: `oauth-${deviceId}`,
    plugin: '@fixture/oauth',
    capability: 'test-capability',
    pluginVersion: '1.0.0',
    identityId: 'memory-identity',
    spaceId: 'default',
    deviceId,
    sessionGeneration: 1,
    options: {},
  };
}

export async function withSharedOAuthDevices(run: (fixture: SharedOAuthDevices) => Promise<void>): Promise<void> {
  const backend = createMemorySyncBackend();
  const objectId = liveAccountFixture().objectId;
  const homes = [mkdtempSync(join(tmpdir(), 'aio-proxy-oauth-a-')), mkdtempSync(join(tmpdir(), 'aio-proxy-oauth-b-'))];
  const databases = homes.map((home) => openDb({ home }));
  const sessions = [backend.connect(), backend.connect()];
  const controller = new AbortController();
  const schema = zod.object({ token: zod.string() });
  try {
    const bindings = [binding('a'), binding('b')];
    const repositories = databases.map((database, index) => {
      const repo = createSyncRepository(database.sqlite);
      repo.writeBinding(bindings[index]!);
      return repo;
    });
    await sessions[0]!.compareAndSwap(accountKey(objectId), null, encode(liveAccountFixture()), controller.signal);
    let afterExchange: (() => void) | undefined;
    const rawCoordinators = sessions.map((session, index) =>
      createSharedOAuthCoordinator({
        binding: bindings[index]!,
        store: createSyncObjectStore(session),
        repo: repositories[index]!,
      }),
    );
    const coordinators = rawCoordinators.map((coordinator) => ({
      async refresh<C>(input: SharedRefreshInput<C>, signal: AbortSignal): Promise<SharedRefreshResult<C>> {
        return coordinator.refresh<C>(
          {
            ...input,
            exchange: async (current: C, exchangeSignal: AbortSignal) => {
              const result = await input.exchange(current, exchangeSignal);
              afterExchange?.();
              return result;
            },
          },
          signal,
        );
      },
      recover: coordinator.recover,
    }));
    const fixture: SharedOAuthDevices = {
      a: coordinators[0]!,
      b: coordinators[1]!,
      objectId,
      schema,
      signal: controller.signal,
      backend,
      repoA: repositories[0]!,
      repoB: repositories[1]!,
      injectAfterExchange(callback) {
        afterExchange = callback;
      },
    };
    await run(fixture);
  } finally {
    controller.abort();
    await Promise.all(sessions.map((session) => session.dispose()));
    for (const database of databases) database.close();
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
}
