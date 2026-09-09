import { expect, test } from 'bun:test';

import type { EntityBody } from '@aio-proxy/core';

import { activateDesired, checkPrerequisites, readOAuthActivationEvidence } from './activation';

const provider: EntityBody = {
  kind: 'provider',
  logicalKey: 'work',
  value: { kind: 'oauth', plugin: '@example/oauth', capability: 'main' },
  dependencies: [{ objectId: 'plugin-object', packageName: '@example/oauth', version: '1.0.0' }],
};

const ready = {
  installedPackages: new Map([['@example/oauth', '1.0.0']]),
  missingEnv: [],
  oauthVerified: true,
  credentialValid: true,
  oauthEvidence: {
    plugin: '@example/oauth',
    capability: 'main',
    pluginVersion: '1.0.0',
    formatVersion: 1,
    phase: 'ready' as const,
    multiDeviceEvidenceId: 'evidence-1',
    expectedFormatVersion: 1,
    expectedMultiDeviceEvidenceId: 'evidence-1',
  },
};

test('activation keeps an OAuth copy pending when evidence is unavailable', async () => {
  await expect(
    checkPrerequisites({
      raw: {},
      body: provider,
      apply: async () => {},
      dependencies: { ...ready, oauthVerified: false },
    }),
  ).resolves.toBe('oauth-unverified');
});

test('activation checks exact dependency versions before applying', async () => {
  const applied: string[] = [];
  const result = await activateDesired({
    raw: {},
    body: provider,
    apply: async (_raw, origin) => applied.push(origin),
    dependencies: { ...ready, installedPackages: new Map([['@example/oauth', '2.0.0']]) },
  });
  expect(result).toEqual({ applied: false, pending: 'incompatible-version' });
  expect(applied).toEqual([]);
});

test('activation forwards remote origin only after all prerequisites pass', async () => {
  const origins: string[] = [];
  const result = await activateDesired({
    raw: {},
    body: provider,
    apply: async (_raw, origin) => origins.push(origin),
    dependencies: ready,
  });
  expect(result).toEqual({ applied: true });
  expect(origins).toEqual(['remote']);
});

test('activation rejects OAuth evidence with the wrong account identity or sync format', async () => {
  await expect(
    checkPrerequisites({
      raw: {},
      body: provider,
      apply: async () => {},
      dependencies: {
        ...ready,
        oauthEvidence: {
          plugin: '@other/oauth',
          capability: 'main',
          pluginVersion: '1.0.0',
          formatVersion: 1,
          phase: 'ready',
          multiDeviceEvidenceId: 'evidence',
          expectedFormatVersion: 2,
          expectedMultiDeviceEvidenceId: 'evidence',
        },
      },
    }),
  ).resolves.toBe('invalid-credential');
  await expect(
    checkPrerequisites({
      raw: {},
      body: provider,
      apply: async () => {},
      dependencies: {
        ...ready,
        oauthEvidence: {
          plugin: '@example/oauth',
          capability: 'main',
          pluginVersion: '1.0.0',
          formatVersion: 1,
          phase: 'ready',
          multiDeviceEvidenceId: 'evidence',
          expectedFormatVersion: 1,
          expectedMultiDeviceEvidenceId: 'other-evidence',
        },
      },
    }),
  ).resolves.toBe('oauth-unverified');
});

test('activation keeps missing or stale account evidence pending', async () => {
  await expect(
    checkPrerequisites({
      raw: {},
      body: provider,
      apply: async () => {},
      dependencies: { ...ready, oauthEvidence: undefined },
    }),
  ).resolves.toBe('oauth-unverified');
  await expect(
    checkPrerequisites({
      raw: {},
      body: provider,
      apply: async () => {},
      dependencies: {
        ...ready,
        oauthEvidence: { ...ready.oauthEvidence, phase: 'refreshing' },
      },
    }),
  ).resolves.toBe('oauth-unverified');
  await expect(
    checkPrerequisites({
      raw: {},
      body: provider,
      apply: async () => {},
      dependencies: {
        ...ready,
        oauthEvidence: { ...ready.oauthEvidence, pluginVersion: '2.0.0' },
      },
    }),
  ).resolves.toBe('incompatible-version');
});

test('verified durable sharing ownership activates the stored account', async () => {
  const { withOAuthSharingFixture } = await import('../../../core/src/sync/oauth/test-support');
  await withOAuthSharingFixture(async (f) => {
    await f.sharing.share(f.providerId, f.signal);
    const account = f.accounts.readAccount(f.providerId)!;
    const entity = f.repo.entities('oauth-sharing')[0]!;
    const evidence = readOAuthActivationEvidence(account, 1, 'fixture-evidence', entity);
    let applied = false;
    const result = await activateDesired({
      raw: {},
      body: {
        kind: 'provider',
        logicalKey: f.providerId,
        value: { kind: 'oauth', plugin: account.plugin, capability: account.capability },
        dependencies: [{ objectId: 'plugin', packageName: account.plugin, version: '1.0.0' }],
      },
      apply: async () => {
        applied = true;
      },
      dependencies: {
        installedPackages: new Map([[account.plugin, '1.0.0']]),
        missingEnv: [],
        oauthVerified: true,
        credentialValid: true,
        oauthEvidence: evidence,
      },
    });
    expect(result).toEqual({ applied: true });
    expect(applied).toBe(true);
    expect(
      readOAuthActivationEvidence({ ...account, revision: account.revision + 1 }, 1, 'fixture-evidence', entity),
    ).toBeUndefined();
  });
});
