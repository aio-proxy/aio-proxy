import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginLogSink } from '@aio-proxy/core';
import type { ModelCatalog } from '@aio-proxy/plugin-sdk';
import type { ProviderAlias } from '@aio-proxy/types';

import { CatalogScheduler } from './catalog-scheduler';
import { createConfigStore } from './config-store';
import type { CatalogJobDescriptor } from './plugin-runtime';

const emptyCatalog = (): ModelCatalog => ({
  language: [],
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
});

const languageCatalog = (...ids: string[]): ModelCatalog => ({
  ...emptyCatalog(),
  language: ids.map((id) => ({ id })),
});

function diagnostics(code: string) {
  return {
    code,
    summary: code,
    retryable: true,
    occurredAt: new Date(0).toISOString(),
  };
}

function job(overrides: Partial<CatalogJobDescriptor> & Pick<CatalogJobDescriptor, 'discover'>): CatalogJobDescriptor {
  return {
    providerId: 'person',
    plugin: '@example/oauth',
    capability: 'default',
    accountRuntimeRevision: 1,
    policy: { kind: 'static' },
    stored: null,
    ...overrides,
  };
}

function settle(): Promise<void> {
  return Bun.sleep(20);
}

test('startedAt is recorded before discover so a catalog written after startedAt loses CAS', async () => {
  let currentTime = 10_000;
  let storedRefreshedAt = 0;
  let casStartedAt: number | undefined;
  let mergeCalls = 0;
  let discoverReleased!: () => void;
  const discoverHold = new Promise<void>((resolve) => {
    discoverReleased = resolve;
  });
  const discoverStarted = Promise.withResolvers<void>();

  const scheduler = new CatalogScheduler({
    repository: {
      compareAndSwapCatalog(input: { readonly startedAt: number }) {
        casStartedAt = input.startedAt;
        return storedRefreshedAt >= input.startedAt ? { ok: false } : { ok: true, revision: 2 };
      },
      writeCatalog() {},
      writeDiagnostic() {
        return true;
      },
      writeCatalogUnavailableIfCurrent() {
        return false;
      },
    } as never,
    diagnostics: ((code: string) => diagnostics(code)) as never,
    now: () => currentTime,
    rebuild: async () => {},
    mergeDefaultAliases() {
      mergeCalls++;
    },
  });

  try {
    scheduler.replaceJobs([
      job({
        defaultAliases: () => ({ fresh: { model: 'new-model' } }),
        discover: async () => {
          discoverStarted.resolve();
          await discoverHold;
          storedRefreshedAt = 15_000;
          currentTime = 20_000;
          return languageCatalog('new-model');
        },
      }),
    ]);

    await discoverStarted.promise;
    expect(casStartedAt).toBeUndefined();
    discoverReleased();
    await settle();

    expect(casStartedAt).toBe(10_000);
    expect(mergeCalls).toBe(0);
  } finally {
    scheduler.close();
  }
});

test('successful refresh insert-only merge uses the CAS revision and keeps edited keys', async () => {
  const discovered = languageCatalog('edited-wire', 'fresh-wire');
  const edited = { model: 'edited-wire', preserve: true as const };
  const suggestedEdited = { model: 'edited-wire' };
  const suggestedFresh = { model: 'fresh-wire', preserve: false as const };
  let merged:
    | {
        readonly providerId: string;
        readonly catalog: ModelCatalog;
        readonly identity: {
          readonly plugin: string;
          readonly capability: string;
          readonly accountRuntimeRevision: number;
          readonly writtenCatalogRevision: number;
        };
      }
    | undefined;
  const providers: Record<string, unknown> = {
    person: { kind: 'oauth', plugin: '@example/oauth', capability: 'default', alias: { logical: edited } },
  };

  const { mergeCatalogDefaultAliases } = await import('./catalog-scheduler');
  const scheduler = new CatalogScheduler({
    repository: {
      compareAndSwapCatalog() {
        return { ok: true, revision: 4 };
      },
      writeCatalog() {},
      writeDiagnostic() {
        return true;
      },
      readAccount: () => ({
        plugin: '@example/oauth',
        capability: 'default',
        runtimeRevision: 2,
      }),
      listPendingAccountOperations: () => [],
      readCatalog: () => ({ catalog: discovered, refreshedAt: 20_000, revision: 4 }),
    } as never,
    diagnostics: ((code: string) => diagnostics(code)) as never,
    rebuild: async () => {},
    mergeDefaultAliases(providerId, catalog, identity) {
      merged = { providerId, catalog, identity };
      const next = mergeCatalogDefaultAliases(providers, {
        providerId,
        catalog,
        identity,
        repository: {
          readAccount: () => ({
            plugin: '@example/oauth',
            capability: 'default',
            runtimeRevision: 2,
          }),
          listPendingAccountOperations: () => [],
          readCatalog: () => ({ catalog: discovered, refreshedAt: 20_000, revision: 4 }),
        } as never,
      });
      Object.assign(providers, next);
    },
  });

  try {
    scheduler.replaceJobs([
      job({
        accountRuntimeRevision: 2,
        defaultAliases: () => ({ logical: suggestedEdited, fresh: suggestedFresh }),
        discover: async () => discovered,
      }),
    ]);
    await settle();

    expect(merged?.providerId).toBe('person');
    expect(merged?.catalog).toEqual(discovered);
    expect(merged?.identity.plugin).toBe('@example/oauth');
    expect(merged?.identity.capability).toBe('default');
    expect(merged?.identity.accountRuntimeRevision).toBe(2);
    expect(merged?.identity.writtenCatalogRevision).toBe(4);
    const alias = (providers['person'] as { alias: ProviderAlias }).alias;
    expect(alias.logical).toBe(edited);
    expect(alias.fresh).toEqual(suggestedFresh);
  } finally {
    scheduler.close();
  }
});

test('a merge throw keeps the CAS catalog and does not write CATALOG_UNAVAILABLE', async () => {
  let casWrites = 0;
  let unavailableWrites = 0;
  let bareDiagnostics = 0;
  let rebuilds = 0;
  const logs: Parameters<PluginLogSink>[0][] = [];
  const scheduler = new CatalogScheduler({
    repository: {
      compareAndSwapCatalog() {
        casWrites++;
        return { ok: true, revision: 3 };
      },
      writeCatalog() {
        throw new Error('TTL success must use compareAndSwapCatalog');
      },
      writeDiagnostic() {
        bareDiagnostics++;
        return true;
      },
      writeCatalogUnavailableIfCurrent() {
        unavailableWrites++;
        return true;
      },
    } as never,
    diagnostics: ((code: string) => diagnostics(code)) as never,
    rebuild: async () => {
      rebuilds++;
    },
    logger: (entry) => logs.push(entry),
    mergeDefaultAliases() {
      throw new Error('suggestions failed');
    },
  });

  try {
    scheduler.replaceJobs([
      job({
        defaultAliases: () => ({ fresh: { model: 'new-model' } }),
        discover: async () => languageCatalog('new-model'),
      }),
    ]);
    await settle();

    expect(casWrites).toBe(1);
    expect(unavailableWrites).toBe(0);
    expect(bareDiagnostics).toBe(0);
    expect(rebuilds).toBe(1);
    expect(logs.map(({ event }) => event)).toContain('plugin.default-aliases.merge.failed');
    expect(logs[0]).toMatchObject({
      code: 'PROVIDER_CONFIG_INVALID',
      context: {
        plugin: '@example/oauth',
        capability: 'default',
        providerId: 'person',
      },
      error: { name: 'Error', message: 'suggestions failed' },
    });
  } finally {
    scheduler.close();
  }
});

test('config store not ready writes catalog, skips merge, and does not throw', async () => {
  const mergeHost: { store: object | undefined } = { store: undefined };
  let casWrites = 0;
  let mergeEntered = 0;
  const scheduler = new CatalogScheduler({
    repository: {
      compareAndSwapCatalog() {
        casWrites++;
        return { ok: true, revision: 1 };
      },
      writeCatalog() {},
      writeDiagnostic() {
        return true;
      },
    } as never,
    diagnostics: ((code: string) => diagnostics(code)) as never,
    rebuild: async () => {},
    mergeDefaultAliases() {
      mergeEntered++;
      if (mergeHost.store === undefined) return;
      throw new Error('store was ready');
    },
  });

  try {
    scheduler.replaceJobs([
      job({
        defaultAliases: () => ({ fresh: { model: 'new-model' } }),
        discover: async () => languageCatalog('new-model'),
      }),
    ]);
    await settle();

    expect(casWrites).toBe(1);
    expect(mergeEntered).toBe(1);
  } finally {
    scheduler.close();
  }
});

test('pre-relogin pending update cannot write catalog or diagnostic even when refreshedAt is old', async () => {
  let casInputs = 0;
  let unavailableWrites = 0;
  let bareDiagnostics = 0;
  let catalogWrites = 0;
  let mergeCalls = 0;
  const successScheduler = new CatalogScheduler({
    repository: {
      compareAndSwapCatalog() {
        casInputs++;
        return { ok: false };
      },
      writeCatalog() {
        catalogWrites++;
      },
      writeDiagnostic() {
        bareDiagnostics++;
        return true;
      },
      writeCatalogUnavailableIfCurrent() {
        unavailableWrites++;
        return true;
      },
    } as never,
    diagnostics: ((code: string) => diagnostics(code)) as never,
    rebuild: async () => {},
    mergeDefaultAliases() {
      mergeCalls++;
    },
  });
  const failureScheduler = new CatalogScheduler({
    repository: {
      compareAndSwapCatalog() {
        throw new Error('failed discover must not CAS');
      },
      writeCatalog() {
        catalogWrites++;
      },
      writeDiagnostic() {
        bareDiagnostics++;
        return true;
      },
      writeCatalogUnavailableIfCurrent() {
        unavailableWrites++;
        return true;
      },
    } as never,
    diagnostics: ((code: string) => diagnostics(code)) as never,
    rebuild: async () => {},
  });

  try {
    successScheduler.replaceJobs([
      job({
        policy: { kind: 'ttl', ttlMs: 1 },
        stored: { catalog: languageCatalog('old-model'), refreshedAt: 0, revision: 1 },
        defaultAliases: () => ({ fresh: { model: 'new-model' } }),
        discover: async () => languageCatalog('new-model'),
      }),
    ]);
    failureScheduler.replaceJobs([
      job({
        policy: { kind: 'ttl', ttlMs: 1 },
        stored: { catalog: languageCatalog('old-model'), refreshedAt: 0, revision: 1 },
        discover: async () => {
          throw new Error('refresh failed during re-login');
        },
      }),
    ]);
    await settle();

    expect(casInputs).toBe(1);
    expect(mergeCalls).toBe(0);
    expect(catalogWrites).toBe(0);
    expect(bareDiagnostics).toBe(0);
    expect(unavailableWrites).toBe(1);
  } finally {
    successScheduler.close();
    failureScheduler.close();
  }
});

test('plugin capability runtimeRevision pending op or revision change skips insert', async () => {
  const { mergeCatalogDefaultAliases } = await import('./catalog-scheduler');
  const discovered = languageCatalog('edited-wire', 'fresh-wire');
  const edited = { model: 'edited-wire' };
  const suggestions = () => ({
    logical: { model: 'edited-wire' },
    fresh: { model: 'fresh-wire' },
  });
  const providers = {
    person: { kind: 'oauth', plugin: '@example/oauth', capability: 'default', alias: { logical: edited } },
  };
  const identity = {
    plugin: '@example/oauth',
    capability: 'default',
    accountRuntimeRevision: 2,
    writtenCatalogRevision: 4,
    defaultAliases: suggestions,
  };
  const matchingAccount = {
    plugin: '@example/oauth',
    capability: 'default',
    runtimeRevision: 2,
  };

  const skipped = [
    mergeCatalogDefaultAliases(providers, {
      providerId: 'person',
      catalog: discovered,
      identity,
      repository: {
        readAccount: () => null,
        listPendingAccountOperations: () => [],
        readCatalog: () => ({ revision: 4 }),
      } as never,
    }),
    mergeCatalogDefaultAliases(providers, {
      providerId: 'person',
      catalog: discovered,
      identity,
      repository: {
        readAccount: () => ({ ...matchingAccount, plugin: '@example/other' }),
        listPendingAccountOperations: () => [],
        readCatalog: () => ({ revision: 4 }),
      } as never,
    }),
    mergeCatalogDefaultAliases(providers, {
      providerId: 'person',
      catalog: discovered,
      identity,
      repository: {
        readAccount: () => ({ ...matchingAccount, capability: 'other' }),
        listPendingAccountOperations: () => [],
        readCatalog: () => ({ revision: 4 }),
      } as never,
    }),
    mergeCatalogDefaultAliases(providers, {
      providerId: 'person',
      catalog: discovered,
      identity,
      repository: {
        readAccount: () => ({ ...matchingAccount, runtimeRevision: 3 }),
        listPendingAccountOperations: () => [],
        readCatalog: () => ({ revision: 4 }),
      } as never,
    }),
    mergeCatalogDefaultAliases(providers, {
      providerId: 'person',
      catalog: discovered,
      identity,
      repository: {
        readAccount: () => matchingAccount,
        listPendingAccountOperations: () => [{ providerId: 'person' }],
        readCatalog: () => ({ revision: 4 }),
      } as never,
    }),
    mergeCatalogDefaultAliases(providers, {
      providerId: 'person',
      catalog: discovered,
      identity,
      repository: {
        readAccount: () => matchingAccount,
        listPendingAccountOperations: () => [],
        readCatalog: () => ({ revision: 5 }),
      } as never,
    }),
  ];

  for (const result of skipped) {
    expect(result).toBe(providers);
  }

  const inserted = mergeCatalogDefaultAliases(providers, {
    providerId: 'person',
    catalog: discovered,
    identity,
    repository: {
      readAccount: () => matchingAccount,
      listPendingAccountOperations: () => [],
      readCatalog: () => ({ revision: 4 }),
    } as never,
  });
  expect(inserted).not.toBe(providers);
  expect((inserted['person'] as { alias: ProviderAlias }).alias.logical).toBe(edited);
  expect((inserted['person'] as { alias: ProviderAlias }).alias.fresh).toEqual({
    model: 'fresh-wire',
    preserve: false,
  });

  const alreadyPresent = mergeCatalogDefaultAliases(providers, {
    providerId: 'person',
    catalog: discovered,
    identity: {
      ...identity,
      defaultAliases: () => ({ logical: { model: 'edited-wire' } }),
    },
    repository: {
      readAccount: () => matchingAccount,
      listPendingAccountOperations: () => [],
      readCatalog: () => ({ revision: 4 }),
    } as never,
  });
  expect(alreadyPresent).toBe(providers);
});

test('matching account and catalog skip insert when the config entry is api or a different plugin', async () => {
  const { mergeCatalogDefaultAliases } = await import('./catalog-scheduler');
  const discovered = languageCatalog('edited-wire', 'fresh-wire');
  const edited = { model: 'edited-wire' };
  const identity = {
    plugin: '@example/oauth',
    capability: 'default',
    accountRuntimeRevision: 2,
    writtenCatalogRevision: 4,
    defaultAliases: () => ({
      logical: { model: 'edited-wire' },
      fresh: { model: 'fresh-wire' },
    }),
  };
  const matchingRepository = {
    readAccount: () => ({
      plugin: '@example/oauth',
      capability: 'default',
      runtimeRevision: 2,
    }),
    listPendingAccountOperations: () => [],
    readCatalog: () => ({ revision: 4 }),
  } as never;
  const apiProviders = {
    person: { kind: 'api', alias: { logical: edited } },
  };
  const otherPluginProviders = {
    person: {
      kind: 'oauth',
      plugin: '@example/other',
      capability: 'default',
      alias: { logical: edited },
    },
  };

  expect(
    mergeCatalogDefaultAliases(apiProviders, {
      providerId: 'person',
      catalog: discovered,
      identity,
      repository: matchingRepository,
    }),
  ).toBe(apiProviders);
  expect(
    mergeCatalogDefaultAliases(otherPluginProviders, {
      providerId: 'person',
      catalog: discovered,
      identity,
      repository: matchingRepository,
    }),
  ).toBe(otherPluginProviders);
});

test('mutateProviders identity no-op does not write or verify and merge with no new keys uses that path', async () => {
  const { mergeCatalogDefaultAliases } = await import('./catalog-scheduler');
  const dir = mkdtempSync(join(tmpdir(), 'aio-store-identity-'));
  const configPath = join(dir, 'config.json');
  const original = `${JSON.stringify({ providers: { person: { kind: 'api', alias: { logical: { model: 'edited-wire' } } } } }, null, 2)}\n`;
  writeFileSync(configPath, original);
  let verifies = 0;
  const store = createConfigStore({
    getConfigPath: () => configPath,
    verify: async () => {
      verifies += 1;
    },
  });

  try {
    await store.mutateProviders((providers) => providers);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(verifies).toBe(0);

    const discovered = languageCatalog('edited-wire');
    await store.mutateProviders((providers) =>
      mergeCatalogDefaultAliases(providers, {
        providerId: 'person',
        catalog: discovered,
        identity: {
          plugin: '@example/oauth',
          capability: 'default',
          accountRuntimeRevision: 1,
          writtenCatalogRevision: 1,
          defaultAliases: () => ({ logical: { model: 'edited-wire' } }),
        },
        repository: {
          readAccount: () => ({
            plugin: '@example/oauth',
            capability: 'default',
            runtimeRevision: 1,
          }),
          listPendingAccountOperations: () => [],
          readCatalog: () => ({ revision: 1 }),
        } as never,
      }),
    );
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(verifies).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
