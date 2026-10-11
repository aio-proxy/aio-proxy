import { expect, mock, test } from 'bun:test';

import type { CatalogJobDescriptor } from '../plugin-runtime';
import { CatalogScheduler } from './catalog-scheduler';

function job(overrides: Partial<CatalogJobDescriptor> & Pick<CatalogJobDescriptor, 'discover'>): CatalogJobDescriptor {
  return {
    providerId: 'person',
    policy: { kind: 'static' },
    stored: null,
    enabled: true,
    markUnavailable: () => false,
    ...overrides,
  };
}

test('a job commit can fence off a catalog written while discovery was pending', async () => {
  let currentTime = 10_000;
  let storedRefreshedAt = 0;
  let committedStartedAt: number | undefined;
  const discoverHold = Promise.withResolvers<void>();
  const discoverStarted = Promise.withResolvers<void>();
  const rebuild = mock(async () => {});
  const markUnavailable = mock(() => false);
  const scheduler = new CatalogScheduler({ now: () => currentTime, rebuild });

  try {
    scheduler.replaceJobs([
      job({
        enabled: false,
        discover: async () => {
          const startedAt = currentTime;
          discoverStarted.resolve();
          await discoverHold.promise;
          return () => {
            committedStartedAt = startedAt;
            return storedRefreshedAt < startedAt;
          };
        },
        markUnavailable,
      }),
    ]);
    const refresh = scheduler.refreshNow('person');
    await discoverStarted.promise;
    expect(committedStartedAt).toBeUndefined();
    storedRefreshedAt = 15_000;
    currentTime = 20_000;
    discoverHold.resolve();

    expect(await refresh).toBe('failed');
    expect(committedStartedAt).toBe(10_000);
    expect(rebuild).not.toHaveBeenCalled();
    expect(markUnavailable).not.toHaveBeenCalled();
  } finally {
    scheduler.close();
  }
});

test('successful refresh calls the job commit and rebuilds without marking it unavailable', async () => {
  const commit = mock(() => true);
  const markUnavailable = mock(() => false);
  const rebuild = mock(async () => {});
  const scheduler = new CatalogScheduler({ rebuild });

  try {
    scheduler.replaceJobs([job({ enabled: false, discover: async () => commit, markUnavailable })]);
    expect(await scheduler.refreshNow('person')).toBe('refreshed');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledWith('catalog');
    expect(markUnavailable).not.toHaveBeenCalled();
  } finally {
    scheduler.close();
  }
});
