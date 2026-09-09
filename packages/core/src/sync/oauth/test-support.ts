import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type OAuthAdapter, zod } from '@aio-proxy/plugin-sdk';

import { openDb } from '../../db';
import { createPluginRepository, type AccountWrite, type PluginRepository } from '../../plugins/repository';
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
import { createOAuthProviderGate, createOAuthSharingService, type OAuthSharingService } from './sharing';

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
    multiDeviceEvidenceId: 'fixture-evidence',
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
  readonly restartA: () => SharedOAuthCoordinator;
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
      confirm: coordinator.confirm,
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
      restartA() {
        return createSharedOAuthCoordinator({
          binding: bindings[0]!,
          store: createSyncObjectStore(sessions[0]!),
          repo: repositories[0]!,
        });
      },
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

export type OAuthSharingFixture = {
  readonly providerId: string;
  readonly objectId: string;
  readonly accountWrite: AccountWrite;
  readonly adapter: OAuthAdapter;
  readonly sharing: OAuthSharingService;
  readonly accounts: PluginRepository;
  readonly repo: SyncRepository;
  readonly backend: MemorySyncBackend;
  readonly signal: AbortSignal;
  readonly ownership: () => ReturnType<SyncRepository['entities']>[number]['oauth'];
  readonly currentCredential: () => unknown;
  readonly remote: () => LiveAccount | null;
  readonly replaceAdapter: (adapter: OAuthAdapter) => void;
  readonly restart: () => OAuthSharingService;
};

export async function withOAuthSharingFixture(
  run: (fixture: OAuthSharingFixture) => Promise<void>,
  options: { readonly shared?: boolean } = {},
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-oauth-sharing-'));
  const database = openDb({ home });
  const backend = createMemorySyncBackend();
  const session = backend.connect();
  const controller = new AbortController();
  const providerId = 'provider-1';
  const objectId = liveAccountFixture().objectId;
  const localBinding = binding('sharing');
  const repo = createSyncRepository(database.sqlite);
  const accounts = createPluginRepository(database.sqlite);
  const accountWrite: AccountWrite = {
    providerId,
    plugin: '@fixture/oauth',
    capability: 'test-capability',
    fingerprint: 'fixture',
    options: {},
    secrets: {},
    credential: { token: 'shared-token' },
    catalog: { kind: 'replace', value: { catalog, refreshedAt: 0 } },
  };
  const pending = accounts.stageAccountOperation({ kind: 'create', targetDigest: 'fixture', account: accountWrite });
  accounts.completeAccountOperation(pending.operationId);
  repo.writeBinding(localBinding);
  repo.putEntity(localBinding.id, {
    objectId,
    logicalKey: providerId,
    kind: 'provider',
    mode: 'included',
    epoch: 0,
    desired: null,
    baseline: null,
    overrides: [],
    pendingReason: null,
    ...(options.shared
      ? {
          oauth: {
            mode: 'shared' as const,
            epoch: 0,
            generation: 0,
            localRevision: 1,
            pluginVersion: '1.0.0',
            formatVersion: 1,
            multiDeviceEvidenceId: 'fixture-evidence',
          },
        }
      : {}),
  });
  if (options.shared) {
    await session.compareAndSwap(
      accountKey(objectId),
      null,
      encode(
        liveAccountFixture({
          objectId,
          payload: { credential: { token: 'shared-token' }, options: {}, secrets: {}, fingerprint: 'fixture' },
        }),
      ),
      controller.signal,
    );
  }
  let adapter = oauthAdapterFixture({
    credentialSync: {
      formatVersion: 1,
      multiDevice: { evidenceId: 'fixture-evidence' },
      canDetach: async () => false,
    },
  });
  const gate = createOAuthProviderGate();
  const store = createSyncObjectStore(session);
  const create = () =>
    createOAuthSharingService({
      binding: localBinding,
      repo,
      accounts,
      store,
      resolveAdapter: () => ({ adapter, pluginVersion: '1.0.0' }),
      withProviderGate: gate.run,
    });
  const sharing = create();
  try {
    await run({
      providerId,
      objectId,
      accountWrite,
      adapter,
      sharing,
      accounts,
      repo,
      backend,
      signal: controller.signal,
      ownership: () => repo.entities(localBinding.id).find((entity) => entity.logicalKey === providerId)?.oauth,
      currentCredential: () => accounts.readAccount(providerId)?.credential,
      remote: () => {
        const value = backend.readAll().get(accountKey(objectId));
        return value?.kind === 'present' ? (JSON.parse(new TextDecoder().decode(value.value)) as LiveAccount) : null;
      },
      replaceAdapter(next) {
        adapter = next;
      },
      restart: create,
    });
  } finally {
    controller.abort();
    await session.dispose();
    database.close();
    rmSync(home, { recursive: true, force: true });
  }
}
