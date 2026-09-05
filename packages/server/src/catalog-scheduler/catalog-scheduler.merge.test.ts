import { expect, test } from 'bun:test';

import type { ModelCatalog } from '@aio-proxy/plugin-sdk';

import type { CatalogJobDescriptor } from '../plugin-runtime';
import { CatalogScheduler } from './catalog-scheduler';

const languageCatalog = (...ids: string[]): ModelCatalog => ({
  language: ids.map((id) => ({ id })),
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
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
    enabled: true,
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
  });

  try {
    scheduler.replaceJobs([
      job({
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
  } finally {
    scheduler.close();
  }
});

test('successful refresh does not write plugin default aliases into the provider entry', async () => {
  let rebuilds = 0;
  const scheduler = new CatalogScheduler({
    repository: {
      compareAndSwapCatalog() {
        return { ok: true, revision: 4 };
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
    rebuild: async () => {
      rebuilds += 1;
    },
  });

  try {
    scheduler.replaceJobs([
      job({
        discover: async () => languageCatalog('fresh-wire'),
      }),
    ]);
    await settle();
    expect(rebuilds).toBe(1);
  } finally {
    scheduler.close();
  }
});
