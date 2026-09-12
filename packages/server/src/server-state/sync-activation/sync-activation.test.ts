import { expect, test } from 'bun:test';

import type {
  EntityBody,
  LocalEntity,
  PluginRegistrySnapshot,
  PluginRepository,
  SyncRepository,
} from '@aio-proxy/core';

import { createActivationCheck } from './sync-activation';

const providerBody = (value: EntityBody['value']): EntityBody => ({
  kind: 'provider',
  logicalKey: 'work',
  value,
  dependencies: [],
});

/** `approved` is what this device already accepted for `work`, if anything. */
const checkWith = (approved?: EntityBody) =>
  createActivationCheck({
    repo: {
      readBinding: () => ({ id: 'binding' }),
      entities: () => (approved === undefined ? [] : [{ ...approved, desired: approved } as unknown as LocalEntity]),
    } as unknown as SyncRepository,
    accounts: {} as PluginRepository,
    plugins: () => ({ registry: { resolveOAuth: () => undefined } }) as unknown as PluginRegistrySnapshot,
    pluginVersions: () => new Map(),
    sharing: () => undefined,
  });

// The running configuration is healthy while the arriving Provider is not: reading the wrong one
// lets an unresolvable reference activate as an empty string.
const runningConfig = { providers: { local: { apiKey: 'literal' } } };

const withEnv = async (run: () => Promise<unknown>) => {
  process.env['AIO_PROXY_TEST_PRESENT'] = 'value';
  try {
    return await run();
  } finally {
    delete process.env['AIO_PROXY_TEST_PRESENT'];
  }
};

test('holds a remote Provider whose environment reference this device cannot resolve', async () => {
  const body = providerBody({ baseURL: 'https://example.test', apiKey: '{{env.AIO_PROXY_TEST_ABSENT}}' });

  expect(await checkWith()(runningConfig, body)).toBe('missing-env');
});

test('activates a remote Provider that references no local secret', async () => {
  const body = providerBody({ baseURL: 'https://example.test', apiKey: 'literal' });

  expect(await checkWith()(runningConfig, body)).toBeUndefined();
});

test('rejects a remote Provider carrying a template this device cannot parse', async () => {
  const body = providerBody({ baseURL: 'https://example.test', apiKey: '{{env.NAME' });

  expect(await checkWith()(runningConfig, body)).toBe('invalid-config');
});

test('activates a remote Provider whose secret keeps going to the destination this device approved', async () => {
  const body = providerBody({ baseURL: 'https://example.test', apiKey: '{{env.AIO_PROXY_TEST_PRESENT}}' });

  expect(await withEnv(() => checkWith(body)(runningConfig, body))).toBeUndefined();
});

// The published body keeps `{{env.NAME}}` unresolved, so a writer with space access cannot read the
// secret — but it can repoint the request that carries it at an origin of its own.
test('holds a remote Provider that repoints an approved secret at a new destination', async () => {
  const approved = providerBody({ baseURL: 'https://example.test', apiKey: '{{env.AIO_PROXY_TEST_PRESENT}}' });
  const body = providerBody({ baseURL: 'https://attacker.test', apiKey: '{{env.AIO_PROXY_TEST_PRESENT}}' });

  expect(await withEnv(() => checkWith(approved)(runningConfig, body))).toBe('secret-conflict');
});

test('holds a remote Provider that introduces a secret this device never approved sending anywhere', async () => {
  const body = providerBody({ baseURL: 'https://example.test', apiKey: '{{env.AIO_PROXY_TEST_PRESENT}}' });

  expect(await withEnv(() => checkWith()(runningConfig, body))).toBe('secret-conflict');
});

// A nested endpoint is a request sink too, so it has to be bound like the top-level one.
test('holds a remote Provider that repoints an approved secret through a nested endpoint', async () => {
  const approved = providerBody({
    baseURL: 'https://example.test',
    apiKey: '{{env.AIO_PROXY_TEST_PRESENT}}',
    endpoints: [{ baseURL: 'https://example.test/v1' }],
  });
  const body = providerBody({
    baseURL: 'https://example.test',
    apiKey: '{{env.AIO_PROXY_TEST_PRESENT}}',
    endpoints: [{ baseURL: 'https://attacker.test/v1' }],
  });

  expect(await withEnv(() => checkWith(approved)(runningConfig, body))).toBe('secret-conflict');
});
