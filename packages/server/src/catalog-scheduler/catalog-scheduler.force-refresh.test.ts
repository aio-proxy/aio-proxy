import { expect, test } from 'bun:test';

import type { CatalogCommit, CatalogJobDescriptor } from '../plugin-runtime';
import { CatalogScheduler } from './catalog-scheduler';

function job(overrides: Partial<CatalogJobDescriptor> & Pick<CatalogJobDescriptor, 'discover'>): CatalogJobDescriptor {
  return {
    providerId: 'person',
    // Far from expiring, so nothing here would ever be rediscovered on a timer.
    policy: { kind: 'ttl', ttlMs: 6 * 60 * 60_000 },
    stored: { refreshedAt: 10_000, revision: 1 },
    enabled: true,
    markUnavailable: () => true,
    ...overrides,
  };
}

test('refreshNow rediscovers and persists a catalog whose TTL has not expired', async () => {
  let discoveries = 0;
  let written: unknown;
  let rebuilds = 0;
  const discovered = ['new-model'];
  const scheduler = new CatalogScheduler({
    now: () => 10_000,
    rebuild: async () => {
      rebuilds++;
    },
  });
  scheduler.replaceJobs([
    job({
      discover: async () => {
        discoveries++;
        return () => {
          written = discovered;
          return true;
        };
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
  const discovery = Promise.withResolvers<CatalogCommit>();
  const scheduler = new CatalogScheduler({
    now: () => 10_000,
    rebuild: async () => {},
  });
  scheduler.replaceJobs([
    job({
      discover: async () => {
        discoveries++;
        return await discovery.promise;
      },
    }),
  ]);

  const first = scheduler.refreshNow('person');
  const second = scheduler.refreshNow('person');
  await Bun.sleep(5);
  discovery.resolve(() => true);

  expect(await Promise.all([first, second])).toEqual(['refreshed', 'refreshed']);
  expect(discoveries).toBe(1);
  scheduler.close();
});

test('refreshNow reports an unknown Provider without discovering anything', async () => {
  let discoveries = 0;
  const scheduler = new CatalogScheduler({
    now: () => 10_000,
    rebuild: async () => {},
  });
  scheduler.replaceJobs([
    job({
      discover: async () => {
        discoveries++;
        return () => true;
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
      markUnavailable() {
        unavailableWrites++;
        return true;
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

test('a refresh whose snapshot rebuild fails reports failure rather than acknowledging', async () => {
  let committed = false;
  const scheduler = new CatalogScheduler({
    now: () => 10_000,
    rebuildRetryMs: 60_000,
    rebuild: async () => {
      throw new Error('rebuild refused');
    },
  });
  scheduler.replaceJobs([
    job({
      discover: async () => () => {
        committed = true;
        return true;
      },
    }),
  ]);

  // The catalog is committed, but generation still serves the previous snapshot, so the caller must
  // not be told the models it can now see are routable.
  expect(await scheduler.refreshNow('person')).toBe('failed');
  expect(committed).toBe(true);
  scheduler.close();
});

test('a disabled Provider is never rediscovered on a timer but stays manually refreshable', async () => {
  let discoveries = 0;
  const scheduler = new CatalogScheduler({
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
        return () => true;
      },
    }),
  ]);

  await Bun.sleep(10);
  expect(discoveries).toBe(0);

  expect(await scheduler.refreshNow('person')).toBe('refreshed');
  expect(discoveries).toBe(1);
  scheduler.close();
});

test('a failed manual refresh of a disabled Provider stays manual instead of arming the retry', async () => {
  let discoveries = 0;
  const scheduler = new CatalogScheduler({
    now: () => 10_000,
    catalogRetryMs: 5,
    rebuild: async () => {},
  });
  scheduler.replaceJobs([
    job({
      enabled: false,
      discover: async () => {
        discoveries++;
        throw new Error('upstream refused');
      },
    }),
  ]);

  expect(await scheduler.refreshNow('person')).toBe('failed');
  expect(discoveries).toBe(1);

  // The failure path must not smuggle a disabled Provider back onto a timer: an enabled one would be
  // rediscovering by now.
  await Bun.sleep(20);
  expect(discoveries).toBe(1);
  scheduler.close();
});
