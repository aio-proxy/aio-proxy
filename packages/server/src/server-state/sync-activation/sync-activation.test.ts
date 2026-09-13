import { expect, test } from 'bun:test';

import type {
  EntityBody,
  JsonValue,
  LocalEntity,
  PluginRegistrySnapshot,
  PluginRepository,
  SyncRepository,
} from '@aio-proxy/core';
import { z } from 'zod';

import { createActivationCheck } from './sync-activation';

const providerBody = (value: EntityBody['value']): EntityBody => ({
  kind: 'provider',
  logicalKey: 'work',
  value,
  dependencies: [],
});

/** `approved` is what this device already accepted for `work`, if anything. */
const checkWith = (approved?: EntityBody) => {
  const check = createActivationCheck({
    repo: {
      readBinding: () => ({ id: 'binding' }),
      entities: () => (approved === undefined ? [] : [{ ...approved, desired: approved } as unknown as LocalEntity]),
    } as unknown as SyncRepository,
    accounts: {} as PluginRepository,
    plugins: () => ({ registry: { resolveOAuth: () => undefined } }) as unknown as PluginRegistrySnapshot,
    pluginVersions: () => new Map(),
    sharing: () => undefined,
  });
  return (raw: Record<string, JsonValue>, body: EntityBody) => check(raw, body, new AbortController().signal);
};

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

// `resolveApiKey()` expands an `apiKey` of `$NAME` from this device's environment, so the legacy
// syntax is as redirectable as `{{env.NAME}}` and has to be bound the same way.
test('holds a remote Provider that repoints a legacy $NAME key at a new destination', async () => {
  const approved = providerBody({ baseURL: 'https://example.test', apiKey: '$AIO_PROXY_TEST_PRESENT' });
  const body = providerBody({ baseURL: 'https://attacker.test', apiKey: '$AIO_PROXY_TEST_PRESENT' });

  expect(await withEnv(() => checkWith(approved)(runningConfig, body))).toBe('secret-conflict');
});

// `close()` aborts the engine controller and then waits for the running reconciliation, so an
// independent controller here lets disconnect, backend replacement or shutdown hang on `receive()`.
test('an OAuth account import is aborted by the reconciliation signal', async () => {
  let received: AbortSignal | undefined;
  const check = createActivationCheck({
    repo: { readBinding: () => null } as unknown as SyncRepository,
    accounts: { readAccount: () => null } as unknown as PluginRepository,
    plugins: () => ({ registry: { resolveOAuth: () => ({ credentials: {} }) } }) as unknown as PluginRegistrySnapshot,
    pluginVersions: () => new Map([['@example/oauth', '1.0.0']]),
    sharing: () =>
      ({
        receive: (_key: string, _context: unknown, signal: AbortSignal) => {
          received = signal;
          return Promise.resolve(null);
        },
      }) as never,
  });
  const controller = new AbortController();

  await check(
    runningConfig,
    providerBody({ kind: 'oauth', plugin: '@example/oauth', capability: 'chat' }),
    controller.signal,
  );

  expect(received).toBe(controller.signal);
});

// The import writes the account's ownership onto the row, so a snapshot taken before that await
// reads as unowned. Handing it to the evidence check holds the Provider unverified forever: the
// account now exists, so the import never runs again.
test('activates an OAuth Provider whose account the import just wrote ownership for', async () => {
  const account = { plugin: '@example/oauth', capability: 'chat', credential: { token: 'secret' }, revision: 3 };
  let row = {
    kind: 'provider',
    logicalKey: 'work',
    desired: null,
    pendingReason: 'oauth-unverified',
    oauth: undefined,
  } as unknown as LocalEntity;
  const check = createActivationCheck({
    repo: {
      readBinding: () => ({ id: 'binding' }),
      // `entities()` reads persisted state, so each call is a fresh snapshot rather than a handle
      // on the row the import mutates.
      entities: () => [{ ...row }],
    } as unknown as SyncRepository,
    accounts: { readAccount: () => null } as unknown as PluginRepository,
    plugins: () =>
      ({
        registry: {
          resolveOAuth: () => ({
            id: 'chat',
            credentials: z.object({ token: z.string() }),
            credentialSync: { formatVersion: 1, multiDevice: { evidenceId: 'evidence-1' } },
          }),
        },
      }) as unknown as PluginRegistrySnapshot,
    pluginVersions: () => new Map([['@example/oauth', '1.0.0']]),
    sharing: () =>
      ({
        receive: () => {
          row = {
            ...row,
            pendingReason: null,
            oauth: {
              mode: 'shared',
              localRevision: account.revision,
              pluginVersion: '1.0.0',
              formatVersion: 1,
              multiDeviceEvidenceId: 'evidence-1',
            },
          } as unknown as LocalEntity;
          return Promise.resolve(account);
        },
      }) as never,
  });

  const pending = await check(
    runningConfig,
    {
      ...providerBody({ kind: 'oauth', plugin: '@example/oauth', capability: 'chat' }),
      dependencies: [{ objectId: 'object-1', packageName: '@example/oauth', version: '1.0.0' }],
    },
    new AbortController().signal,
  );

  expect(pending).toBeUndefined();
});
