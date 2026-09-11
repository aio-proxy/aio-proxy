import { expect, test } from 'bun:test';

import type { EntityBody, PluginRegistrySnapshot, PluginRepository, SyncRepository } from '@aio-proxy/core';

import { createActivationCheck } from './sync-activation';

const check = createActivationCheck({
  repo: {} as SyncRepository,
  accounts: {} as PluginRepository,
  plugins: () => ({ registry: { resolveOAuth: () => undefined } }) as unknown as PluginRegistrySnapshot,
  pluginVersions: () => new Map(),
  sharing: () => undefined,
});

const providerBody = (value: EntityBody['value']): EntityBody => ({
  kind: 'provider',
  logicalKey: 'work',
  value,
  dependencies: [],
});

// The running configuration is healthy while the arriving Provider is not: reading the wrong one
// lets an unresolvable reference activate as an empty string.
const runningConfig = { providers: { local: { apiKey: 'literal' } } };

test('holds a remote Provider whose environment reference this device cannot resolve', async () => {
  const body = providerBody({ baseURL: 'https://example.test', apiKey: '{{env.AIO_PROXY_TEST_ABSENT}}' });

  expect(await check(runningConfig, body)).toBe('missing-env');
});

test('activates a remote Provider once every environment reference resolves', async () => {
  process.env['AIO_PROXY_TEST_PRESENT'] = 'value';
  const body = providerBody({ baseURL: 'https://example.test', apiKey: '{{env.AIO_PROXY_TEST_PRESENT}}' });

  try {
    expect(await check(runningConfig, body)).toBeUndefined();
  } finally {
    delete process.env['AIO_PROXY_TEST_PRESENT'];
  }
});

test('rejects a remote Provider carrying a template this device cannot parse', async () => {
  const body = providerBody({ baseURL: 'https://example.test', apiKey: '{{env.NAME' });

  expect(await check(runningConfig, body)).toBe('invalid-config');
});
