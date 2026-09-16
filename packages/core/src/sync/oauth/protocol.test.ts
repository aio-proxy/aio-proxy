import { expect, test } from 'bun:test';

import { canActivateSyncedAccount, decodeAccount } from './protocol';
import { liveAccountFixture, oauthAdapterFixture } from './test-support';

test('format metadata permits storage while missing evidence blocks activation', () => {
  const adapter = oauthAdapterFixture({ credentialSync: { formatVersion: 1 } });
  const account = liveAccountFixture();
  expect(adapter.credentialSync?.formatVersion).toBe(1);
  expect(canActivateSyncedAccount(adapter, account.pluginVersion, account)).toBe(false);
});

test('verified metadata activates only an exact ready account version', () => {
  const adapter = oauthAdapterFixture({
    credentialSync: { formatVersion: 1, multiDevice: { evidenceId: 'fixture-evidence' } },
  });
  const account = liveAccountFixture();
  expect(canActivateSyncedAccount(adapter, '1.0.0', account)).toBe(true);
  expect(canActivateSyncedAccount(adapter, '1.0.1', account)).toBe(false);
  expect(canActivateSyncedAccount(adapter, '1.0.0', { ...account, phase: 'refreshing' })).toBe(false);
  expect(canActivateSyncedAccount(adapter, '1.0.0', { ...account, formatVersion: 2 })).toBe(false);
});

test('decodeAccount accepts the shared current account and deleted tombstone', () => {
  const account = liveAccountFixture();
  expect(decodeAccount(new TextEncoder().encode(JSON.stringify(account)))).toEqual(account);
  const deleted = { protocol: 1, phase: 'deleted', objectId: account.objectId, epoch: 1 } as const;
  expect(decodeAccount(new TextEncoder().encode(JSON.stringify(deleted)))).toEqual(deleted);
});
