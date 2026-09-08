import { expect, test } from 'bun:test';

import type { PluginRepository } from '../repository';
import { createCredentialPort } from './credential-port';
import { credentialPortOptions, createFixtureScope } from './test-support';

test('shared refresh bypasses local lease acquisition', async () => {
  const scope = createFixtureScope();
  const { repository } = scope.open();
  try {
    let sharedCalls = 0;
    let localLeaseCalls = 0;
    const options = credentialPortOptions<{ token: string }>(repository, {
      repository: {
        ...repository,
        tryAcquireRefreshLease: (...args: Parameters<PluginRepository['tryAcquireRefreshLease']>) => {
          localLeaseCalls++;
          return repository.tryAcquireRefreshLease(...args);
        },
      },
      resolveShared: () => ({
        read: async () => ({ value: { token: 'old' }, revision: 1 }),
        refresh: async () => {
          sharedCalls++;
          return { status: 'updated', snapshot: { value: { token: 'new' }, revision: 2 } };
        },
      }),
    });
    const port = createCredentialPort(options);
    await port.refresh(1, async () => ({ value: { token: 'unused' } }));
    expect(sharedCalls).toBe(1);
    expect(localLeaseCalls).toBe(0);
  } finally {
    scope.cleanup();
  }
});

test('local refresh still acquires the local lease when ownership is absent', async () => {
  const scope = createFixtureScope();
  const { repository } = scope.open();
  try {
    let localLeaseCalls = 0;
    const options = credentialPortOptions<{ token: string }>(repository, {
      repository: {
        ...repository,
        tryAcquireRefreshLease: (...args: Parameters<PluginRepository['tryAcquireRefreshLease']>) => {
          localLeaseCalls++;
          return repository.tryAcquireRefreshLease(...args);
        },
      },
    });
    const port = createCredentialPort(options);
    await port.refresh(1, async () => ({ value: { token: 'new' } }));
    expect(localLeaseCalls).toBe(1);
  } finally {
    scope.cleanup();
  }
});
