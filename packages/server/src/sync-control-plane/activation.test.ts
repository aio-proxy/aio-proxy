import { expect, test } from 'bun:test';

import type { EntityBody } from '@aio-proxy/core';

import { activateDesired, checkPrerequisites } from './activation';

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
        },
      },
    }),
  ).resolves.toBe('oauth-unverified');
});
