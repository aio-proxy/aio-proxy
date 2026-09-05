import { expect, test } from 'bun:test';

import { CatalogScheduler } from './catalog-scheduler';
import type { CatalogJobDescriptor } from './plugin-runtime';

const emptyCatalog = () => ({
  language: [],
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
});

const repository = {
  compareAndSwapCatalog() {
    return { ok: true, revision: 1 };
  },
  writeCatalogUnavailableIfCurrent() {
    return true;
  },
  writeCatalog() {},
  writeDiagnostic() {
    return true;
  },
  clearDiagnostic() {
    return true;
  },
};

const diagnostics = ((code: string) => ({
  code,
  summary: code,
  retryable: true,
  occurredAt: new Date().toISOString(),
})) as never;

function job(overrides: Partial<CatalogJobDescriptor> & Pick<CatalogJobDescriptor, 'discover'>): CatalogJobDescriptor {
  return {
    providerId: 'person',
    plugin: '@example/oauth',
    capability: 'default',
    accountRuntimeRevision: 1,
    // Far from expiring, so nothing here would ever be rediscovered on a timer.
    policy: { kind: 'ttl', ttlMs: 6 * 60 * 60_000 },
    stored: { catalog: emptyCatalog(), refreshedAt: 10_000, revision: 1 },
    enabled: true,
    ...overrides,
  };
}

test('refreshNow rediscovers and persists a catalog whose TTL has not expired', async () => {
  let discoveries = 0;
  let written: unknown;
  let rebuilds = 0;
  const discovered = { ...emptyCatalog(), language: [{ id: 'new-model' }] };
  const scheduler = new CatalogScheduler({
    repository: {
      ...repository,
      compareAndSwapCatalog(input: { readonly catalog: unknown }) {
        written = input.catalog;
        return { ok: true, revision: 2 };
      },
    } as never,
    diagnostics,
    now: () => 10_000,
    rebuild: async () => {
      rebuilds++;
    },
  });
  scheduler.replaceJobs([
    job({
      discover: async () => {
        discoveries++;
        return discovered;
      },
    }),
  ]);

  await Bun.sleep(10);
  expect(discoveries).toBe(0);

  // The rebuild is awaited inside the refresh, so the new catalog is readable once this resolves.
  expect(await scheduler.refreshNow('person')).toBe('refreshed');
  expect(discoveries).toBe(1);
  expect(written).toEqual(discovered);
  expect(rebuilds).toBe(1);
  scheduler.close();
});

test('concurrent refreshNow calls share one upstream discovery', async () => {
  let discoveries = 0;
  let resolveDiscovery = (_value: ReturnType<typeof emptyCatalog>) => {};
  const scheduler = new CatalogScheduler({
    repository: repository as never,
    diagnostics,
    now: () => 10_000,
    rebuild: async () => {},
  });
  scheduler.replaceJobs([
    job({
      discover: async () => {
        discoveries++;
        return await new Promise((resolve) => {
          resolveDiscovery = resolve;
        });
      },
    }),
  ]);

  const first = scheduler.refreshNow('person');
  const second = scheduler.refreshNow('person');
  await Bun.sleep(5);
  resolveDiscovery(emptyCatalog());

  expect(await Promise.all([first, second])).toEqual(['refreshed', 'refreshed']);
  expect(discoveries).toBe(1);
  scheduler.close();
});

test('refreshNow reports an unknown Provider without discovering anything', async () => {
  let discoveries = 0;
  const scheduler = new CatalogScheduler({
    repository: repository as never,
    diagnostics,
    now: () => 10_000,
    rebuild: async () => {},
  });
  scheduler.replaceJobs([
    job({
      discover: async () => {
        discoveries++;
        return emptyCatalog();
      },
    }),
  ]);

  expect(await scheduler.refreshNow('absent')).toBe('unknown');
  expect(discoveries).toBe(0);
  scheduler.close();
});

test('a failed refreshNow records the catalog diagnostic and arms the retry', async () => {
  let unavailableWrites = 0;
  let discoveries = 0;
  const scheduler = new CatalogScheduler({
    repository: {
      ...repository,
      writeCatalogUnavailableIfCurrent() {
        unavailableWrites++;
        return true;
      },
    } as never,
    diagnostics,
    now: () => 10_000,
    catalogRetryMs: 5,
    rebuild: async () => {},
  });
  scheduler.replaceJobs([
    job({
      discover: async () => {
        discoveries++;
        throw new Error('upstream refused');
      },
    }),
  ]);

  expect(await scheduler.refreshNow('person')).toBe('failed');
  expect(unavailableWrites).toBe(1);

  // The retry the failure armed fires on its own, without another click.
  await Bun.sleep(20);
  expect(discoveries).toBeGreaterThanOrEqual(2);
  scheduler.close();
});

test('a disabled Provider is never rediscovered on a timer but stays manually refreshable', async () => {
  let discoveries = 0;
  const scheduler = new CatalogScheduler({
    repository: repository as never,
    diagnostics,
    now: () => 10_000,
    rebuild: async () => {},
  });
  scheduler.replaceJobs([
    job({
      enabled: false,
      // A missing catalog is due immediately for an enabled Provider, so only `enabled` can keep the
      // timer disarmed here.
      stored: null,
      policy: { kind: 'static' },
      discover: async () => {
        discoveries++;
        return emptyCatalog();
      },
    }),
  ]);

  await Bun.sleep(10);
  expect(discoveries).toBe(0);

  expect(await scheduler.refreshNow('person')).toBe('refreshed');
  expect(discoveries).toBe(1);
  scheduler.close();
});
