import { expect, test } from 'bun:test';

import type { CatalogCommit, CatalogJobDescriptor } from '../plugin-runtime';
import { CatalogScheduler } from './catalog-scheduler';

function job(overrides: Partial<CatalogJobDescriptor> & Pick<CatalogJobDescriptor, 'discover'>): CatalogJobDescriptor {
  return {
    providerId: 'person',
    policy: { kind: 'static' },
    stored: null,
    enabled: true,
    markUnavailable: () => true,
    ...overrides,
  };
}

test('static catalogs with a stored first result do not schedule discovery', async () => {
  let calls = 0;
  const scheduler = new CatalogScheduler({ rebuild: async () => {} });
  scheduler.replaceJobs([
    job({
      stored: { refreshedAt: 0, revision: 1 },
      discover: async () => {
        calls++;
        throw new Error('must not run');
      },
    }),
  ]);
  await Bun.sleep(10);
  expect(calls).toBe(0);
  scheduler.close();
});

test('a migrated TTL catalog with revision 0 rediscovers immediately even when recently refreshed', async () => {
  let discoveries = 0;
  const scheduler = new CatalogScheduler({
    now: () => 10_000,
    rebuild: async () => {},
  });
  scheduler.replaceJobs([
    job({
      policy: { kind: 'ttl', ttlMs: 6 * 60 * 60_000 },
      stored: { refreshedAt: 9_000, revision: 0 },
      discover: async () => {
        discoveries++;
        return () => true;
      },
    }),
  ]);
  await Bun.sleep(20);
  expect(discoveries).toBe(1);
  scheduler.close();
});

test('close aborts an in-flight discovery and discards it', async () => {
  let aborted = false;
  const scheduler = new CatalogScheduler({ rebuild: async () => {} });
  scheduler.replaceJobs([
    job({
      discover: (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        ),
    }),
  ]);
  await Bun.sleep(10);
  scheduler.close();
  await Bun.sleep(0);
  expect(aborted).toBe(true);
});

test('an overdue TTL catalog persists discovery and rebuilds the runtime snapshot', async () => {
  let written: unknown;
  let rebuilds = 0;
  const scheduler = new CatalogScheduler({
    now: () => 10_000,
    rebuild: async () => {
      rebuilds++;
    },
  });
  const discovered = ['new-model'];
  scheduler.replaceJobs([
    job({
      policy: { kind: 'ttl', ttlMs: 1_000 },
      stored: { refreshedAt: 0, revision: 1 },
      discover: async () => () => {
        written = discovered;
        return true;
      },
    }),
  ]);

  await Bun.sleep(20);
  expect(written).toEqual(discovered);
  expect(rebuilds).toBe(1);
  scheduler.close();
});

test('replacing a job while discovery is in flight discards the late catalog', async () => {
  const discovery = Promise.withResolvers<CatalogCommit>();
  let catalogWrites = 0;
  let rebuilds = 0;
  const scheduler = new CatalogScheduler({
    rebuild: async () => {
      rebuilds++;
    },
  });
  scheduler.replaceJobs([job({ discover: async () => await discovery.promise })]);
  await Bun.sleep(10);
  scheduler.replaceJobs([]);
  discovery.resolve(() => {
    catalogWrites++;
    return true;
  });

  await Bun.sleep(10);
  expect(catalogWrites).toBe(0);
  expect(rebuilds).toBe(0);
  scheduler.close();
});

test('close cancels a pending post-persistence rebuild retry', async () => {
  let rebuilds = 0;
  const scheduler = new CatalogScheduler({
    rebuildRetryMs: 10,
    rebuild: async () => {
      rebuilds++;
      throw new Error('rebuild failed');
    },
  });
  scheduler.replaceJobs([job({ discover: async () => () => true })]);

  await Bun.sleep(5);
  expect(rebuilds).toBe(1);
  scheduler.close();
  await Bun.sleep(30);
  expect(rebuilds).toBe(1);
});
