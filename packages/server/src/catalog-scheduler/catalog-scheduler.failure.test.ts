import { expect, mock, test } from 'bun:test';

import type { CatalogJobDescriptor } from '../plugin-runtime';
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

test('an aborted refresh commits nothing', async () => {
  const discoveryStarted = Promise.withResolvers<void>();
  const discovery = Promise.withResolvers<() => boolean>();
  const commit = mock(() => true);
  const rebuild = mock(async () => {});
  const markUnavailable = mock(() => true);
  const scheduler = new CatalogScheduler({ rebuild });
  try {
    scheduler.replaceJobs([
      job({
        enabled: false,
        discover: async () => {
          discoveryStarted.resolve();
          return await discovery.promise;
        },
        markUnavailable,
      }),
    ]);
    const refresh = scheduler.refreshNow('person');
    await discoveryStarted.promise;
    scheduler.replaceJobs([]);
    discovery.resolve(commit);

    expect(await refresh).toBe('failed');
    expect(commit).not.toHaveBeenCalled();
    expect(rebuild).not.toHaveBeenCalled();
    expect(markUnavailable).not.toHaveBeenCalled();
  } finally {
    scheduler.close();
  }
});

test('the rebuild is requested in the same turn as the commit', async () => {
  let committed = false;
  let microtaskRan = false;
  const commit = mock(() => {
    committed = true;
    queueMicrotask(() => {
      microtaskRan = true;
    });
    return true;
  });
  const rebuild = mock(async () => {
    expect(committed).toBe(true);
    expect(microtaskRan).toBe(false);
  });
  const scheduler = new CatalogScheduler({ rebuild });
  try {
    scheduler.replaceJobs([job({ enabled: false, discover: async () => commit })]);

    expect(await scheduler.refreshNow('person')).toBe('refreshed');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledWith('catalog');
  } finally {
    scheduler.close();
  }
});

test('host deadline settles discovery even when the plugin ignores abort', async () => {
  let diagnostics = 0;
  let rebuilds = 0;
  const scheduler = new CatalogScheduler({
    rebuild: async () => {
      rebuilds++;
    },
    discoveryTimeoutMs: 5,
  });
  scheduler.replaceJobs([
    job({
      discover: async () => new Promise<never>(() => {}),
      markUnavailable(error) {
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).name).toBe('TimeoutError');
        diagnostics++;
        return true;
      },
    }),
  ]);

  await Bun.sleep(30);
  expect(diagnostics).toBe(1);
  expect(rebuilds).toBe(1);
  scheduler.close();
});

test('a fenced unavailable write skips rebuild and still retries discovery', async () => {
  let discoveries = 0;
  let rebuilds = 0;
  const scheduler = new CatalogScheduler({
    catalogRetryMs: 20,
    rebuild: async () => {
      rebuilds++;
    },
  });
  scheduler.replaceJobs([
    job({
      discover: async () => {
        discoveries++;
        throw new Error('refresh failed');
      },
      markUnavailable: () => false,
    }),
  ]);

  await Bun.sleep(10);
  expect(discoveries).toBeGreaterThanOrEqual(1);
  expect(rebuilds).toBe(0);
  await Bun.sleep(50);
  expect(discoveries).toBeGreaterThan(1);
  expect(rebuilds).toBe(0);
  scheduler.close();
});

test('a catalog that resolves after the host deadline is discarded', async () => {
  let catalogWrites = 0;
  let diagnosticWrites = 0;
  let resolveDiagnostic = () => {};
  let resolveDiscovery = () => {};
  const diagnosticWritten = new Promise<void>((resolve) => {
    resolveDiagnostic = resolve;
  });
  const discoveryResolved = new Promise<void>((resolve) => {
    resolveDiscovery = resolve;
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const scheduler = new CatalogScheduler({
    rebuild: async () => {},
    discoveryTimeoutMs: 5,
  });
  try {
    scheduler.replaceJobs([
      job({
        discover: async () => {
          await Bun.sleep(20);
          resolveDiscovery();
          return () => {
            catalogWrites++;
            return true;
          };
        },
        markUnavailable() {
          diagnosticWrites++;
          resolveDiagnostic();
          return true;
        },
      }),
    ]);

    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('timed out waiting for the deadline diagnostic and late discovery')),
        1_000,
      );
    });
    await Promise.race([Promise.all([diagnosticWritten, discoveryResolved]), deadline]);
    await Bun.sleep(0);
    expect(diagnosticWrites).toBe(1);
    expect(catalogWrites).toBe(0);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    scheduler.close();
  }
});

test('a discovery failure is diagnosed without committing catalog data', async () => {
  const commit = mock(() => true);
  const error = new Error('invalid catalog');
  const markUnavailable = mock(() => true);
  const rebuild = mock(async () => {});
  const scheduler = new CatalogScheduler({ rebuild });
  try {
    scheduler.replaceJobs([
      job({
        enabled: false,
        discover: async () => {
          // Catalog validation belongs to the job; a rejected discovery never exposes its commit.
          await Promise.reject(error);
          return commit;
        },
        markUnavailable,
      }),
    ]);

    expect(await scheduler.refreshNow('person')).toBe('failed');
    expect(commit).not.toHaveBeenCalled();
    expect(markUnavailable).toHaveBeenCalledWith(error);
    expect(rebuild).toHaveBeenCalledTimes(1);
  } finally {
    scheduler.close();
  }
});

test('a rebuild failure after successful persistence retries without rediscovering or writing a diagnostic', async () => {
  let discoveries = 0;
  let catalogWrites = 0;
  let diagnosticWrites = 0;
  let rebuilds = 0;
  const scheduler = new CatalogScheduler({
    rebuild: async () => {
      rebuilds++;
      if (rebuilds === 1) throw new Error('router rebuild failed');
    },
    rebuildRetryMs: 5,
  });
  scheduler.replaceJobs([
    job({
      discover: async () => {
        discoveries++;
        return () => {
          catalogWrites++;
          return true;
        };
      },
      markUnavailable() {
        diagnosticWrites++;
        return true;
      },
    }),
  ]);

  await Bun.sleep(40);
  expect(discoveries).toBe(1);
  expect(catalogWrites).toBe(1);
  expect(diagnosticWrites).toBe(0);
  expect(rebuilds).toBe(2);
  scheduler.close();
});

test('a fenced CAS rejection retries discovery without writing CATALOG_UNAVAILABLE', async () => {
  let discoveries = 0;
  let catalogWrites = 0;
  let diagnosticWrites = 0;
  let rebuilds = 0;
  const scheduler = new CatalogScheduler({
    catalogRetryMs: 20,
    rebuild: async () => {
      rebuilds++;
    },
  });
  scheduler.replaceJobs([
    job({
      discover: async () => {
        discoveries++;
        return () => {
          catalogWrites++;
          return catalogWrites !== 1;
        };
      },
      markUnavailable() {
        diagnosticWrites++;
        return true;
      },
    }),
  ]);

  await Bun.sleep(10);
  expect(discoveries).toBe(1);
  expect(catalogWrites).toBe(1);
  expect(diagnosticWrites).toBe(0);
  expect(rebuilds).toBe(0);
  await Bun.sleep(30);
  expect(discoveries).toBe(2);
  expect(catalogWrites).toBe(2);
  expect(diagnosticWrites).toBe(0);
  expect(rebuilds).toBe(1);
  scheduler.close();
});

test('a failed TTL refresh preserves last-known-good and waits the host retry interval', async () => {
  let discoveries = 0;
  let catalogWrites = 0;
  let diagnosticWrites = 0;
  let rebuilds = 0;
  const scheduler = new CatalogScheduler({
    catalogRetryMs: 20,
    rebuild: async () => {
      rebuilds++;
    },
  });
  scheduler.replaceJobs([
    job({
      policy: { kind: 'ttl', ttlMs: 1 },
      stored: { refreshedAt: 0, revision: 1 },
      discover: async () => {
        discoveries++;
        if (discoveries === 1) throw new Error('refresh failed');
        await new Promise<never>(() => {});
        return () => {
          catalogWrites++;
          return true;
        };
      },
      markUnavailable() {
        diagnosticWrites++;
        return true;
      },
    }),
  ]);

  await Bun.sleep(10);
  expect(discoveries).toBe(1);
  expect(catalogWrites).toBe(0);
  expect(diagnosticWrites).toBe(1);
  expect(rebuilds).toBe(1);
  await Bun.sleep(30);
  expect(discoveries).toBe(2);
  scheduler.close();
});
