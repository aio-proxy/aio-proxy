import { expect, mock, test } from 'bun:test';

import { AgentRuntimeError } from '@aio-proxy/agent-provider-runtime';
import type { AgentCatalogV1, AgentManagedMarker } from '@aio-proxy/types';

import {
  loginPiFamily,
  piFamilyUnavailableMessage,
  readPiFamilyModels,
  refreshPiFamilyCredential,
  toPiFamilyModels,
} from './core';

const marker = {
  format: 1,
  managedBy: 'aio-proxy',
  agent: 'pi',
  installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  adapterVersion: '1.2.3',
  endpoint: 'http://127.0.0.1:9317',
} as const satisfies AgentManagedMarker;

const catalog: AgentCatalogV1 = {
  schema_version: 1,
  agent: 'pi',
  models: [
    {
      id: 'gpt-x',
      name: 'GPT X',
      reasoning: true,
      tool_call: false,
      temperature: true,
      attachment: true,
      input: ['text', 'image', 'audio', 'video', 'pdf'],
      context_window: 200_000,
      max_output_tokens: 64_000,
    },
  ],
};

test('maps the common Pi-family surface without inventing modalities or prices', () => {
  expect(toPiFamilyModels(catalog)).toEqual([
    {
      id: 'gpt-x',
      name: 'GPT X',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    },
  ]);
});

test('uses host-required numeric defaults only for null limits', () => {
  const nullLimits = structuredClone(catalog);
  nullLimits.models[0]!.context_window = null;
  nullLimits.models[0]!.max_output_tokens = null;
  expect(toPiFamilyModels(nullLimits)[0]).toMatchObject({ contextWindow: 128_000, maxTokens: 16_384 });
  nullLimits.models[0]!.context_window = 8_000;
  expect(toPiFamilyModels(nullLimits)[0]).toMatchObject({ contextWindow: 8_000, maxTokens: 8_000 });
});

test('login presents the exact Device response and returns host-owned OAuth credentials', async () => {
  const present = mock(() => {});
  const device = {
    device_code: 'device-code',
    user_code: 'ABCD-EFGH',
    verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
    verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
    expires_in: 600,
    interval: 5,
  } as const;
  const credentials = await loginPiFamily(
    {
      rootDir: '/managed',
      markerPath: '/managed/.aio-proxy-managed.json',
      statePath: '/managed/.aio-proxy-state.json',
      marker,
    },
    present,
    {
      now: () => 1_000,
      requestDeviceAuthorization: async () => device,
      pollDeviceAuthorization: async () => ({
        token_type: 'Bearer',
        access_token: 'aio_agent_at_v1_access',
        refresh_token: 'aio_agent_rt_v1_refresh',
        expires_in: 900,
      }),
      refreshAgentCatalog: async () => ({ catalog, source: 'network', status: 'fresh' }),
    },
  );
  expect(present).toHaveBeenCalledWith(device);
  expect(credentials).toEqual({
    access: 'aio_agent_at_v1_access',
    refresh: 'aio_agent_rt_v1_refresh',
    expires: 901_000,
  });
});

test('login rejects a freshly issued credential that cannot read the catalog', async () => {
  await expect(
    loginPiFamily(
      {
        rootDir: '/managed',
        markerPath: '/managed/.aio-proxy-managed.json',
        statePath: '/managed/.aio-proxy-state.json',
        marker,
      },
      () => {},
      {
        requestDeviceAuthorization: async () => ({
          device_code: 'device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
          verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
          expires_in: 600,
          interval: 5,
        }),
        pollDeviceAuthorization: async () => ({
          token_type: 'Bearer',
          access_token: 'aio_agent_at_v1_access',
          refresh_token: 'aio_agent_rt_v1_refresh',
          expires_in: 900,
        }),
        refreshAgentCatalog: async () => ({
          catalog,
          source: 'lkg',
          status: 'stale',
          error: 'unauthorized',
        }),
      },
    ),
  ).rejects.toThrow('aio-proxy login required');
});

test('refresh returns a complete rotated credential and forwards cancellation', async () => {
  const signal = AbortSignal.abort('test cancellation is passed but not observed by this stub');
  const refresh = mock(async (_marker, _token, options) => {
    expect(options.signal).toBe(signal);
    return {
      token_type: 'Bearer' as const,
      access_token: 'aio_agent_at_v1_new',
      refresh_token: 'aio_agent_rt_v1_new',
      expires_in: 900,
    };
  });
  await expect(
    refreshPiFamilyCredential(
      marker,
      { access: 'old', refresh: 'aio_agent_rt_v1_old', expires: 0 },
      {
        now: () => 2_000,
        signal,
        refreshAgentCredential: refresh,
      },
    ),
  ).resolves.toEqual({ access: 'aio_agent_at_v1_new', refresh: 'aio_agent_rt_v1_new', expires: 902_000 });
});

test('refresh invalid_grant becomes one stable host-visible login diagnostic', async () => {
  await expect(
    refreshPiFamilyCredential(
      marker,
      { access: 'old', refresh: 'aio_agent_rt_v1_old', expires: 0 },
      {
        refreshAgentCredential: async () => {
          throw new AgentRuntimeError('invalid_grant');
        },
      },
    ),
  ).rejects.toThrow('aio-proxy login required');
});

test('overlapping refresh shares one exchange and releases it after settlement', async () => {
  const credential = { access: 'old', refresh: 'aio_agent_rt_v1_old', expires: 0 };
  let releaseStarted!: () => void;
  let releaseExchange!: () => void;
  const started = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    releaseExchange = resolve;
  });
  const exchange = mock(async () => {
    releaseStarted();
    await hold;
    return {
      token_type: 'Bearer' as const,
      access_token: 'aio_agent_at_v1_new',
      refresh_token: 'aio_agent_rt_v1_new',
      expires_in: 900,
    };
  });
  const options = { now: () => 2_000, refreshAgentCredential: exchange };
  const first = refreshPiFamilyCredential(marker, credential, options);
  const second = refreshPiFamilyCredential(marker, credential, options);
  await started;
  expect(exchange).toHaveBeenCalledTimes(1);
  releaseExchange();
  const rotated = { access: 'aio_agent_at_v1_new', refresh: 'aio_agent_rt_v1_new', expires: 902_000 };
  await expect(Promise.all([first, second])).resolves.toEqual([rotated, rotated]);
  const exchanged = { access: 'aio_agent_at_v1_new', refresh: 'aio_agent_rt_v1_new', expires: 903_000 };
  await expect(
    refreshPiFamilyCredential(marker, rotated, {
      now: () => 3_000,
      refreshAgentCredential: exchange,
    }),
  ).resolves.toEqual(exchanged);
  expect(exchange).toHaveBeenCalledTimes(2);
  await expect(
    refreshPiFamilyCredential(marker, credential, {
      now: () => 3_000,
      refreshAgentCredential: exchange,
    }),
  ).resolves.toEqual(exchanged);
  expect(exchange).toHaveBeenCalledTimes(3);
});

const managed = {
  rootDir: '/managed',
  markerPath: '/managed/.aio-proxy-managed.json',
  statePath: '/managed/.aio-proxy-state.json',
  marker,
} as const;

test.each([
  ['unauthorized', 'aio-proxy login required'],
  ['network', 'aio-proxy server required'],
  ['server_error', 'aio-proxy server required'],
  ['invalid_json', 'aio-proxy server required'],
  ['invalid_catalog', 'aio-proxy server required'],
  ['unsupported_schema', 'aio-proxy adapter upgrade required'],
] as const)('missing %s maps to %s', (error, message) => {
  expect(piFamilyUnavailableMessage(error)).toBe(message);
});

test.each([
  'unauthorized',
  'network',
  'server_error',
  'invalid_json',
  'invalid_catalog',
  'unsupported_schema',
] as const)('readPiFamilyModels preserves missing %s without inventing models', async (error) => {
  await expect(
    readPiFamilyModels(managed, 'token', {
      refreshAgentCatalog: async () => ({ catalog: null, source: 'missing', status: 'missing', error }),
    }),
  ).resolves.toEqual({ models: [], source: 'missing', status: 'missing', error });
});

test('login rejects a missing catalog with the spec start-server diagnostic', async () => {
  await expect(
    loginPiFamily(managed, () => {}, {
      requestDeviceAuthorization: async () => ({
        device_code: 'device-code',
        user_code: 'ABCD-EFGH',
        verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
        verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
        expires_in: 600,
        interval: 5,
      }),
      pollDeviceAuthorization: async () => ({
        token_type: 'Bearer',
        access_token: 'aio_agent_at_v1_access',
        refresh_token: 'aio_agent_rt_v1_refresh',
        expires_in: 900,
      }),
      refreshAgentCatalog: async () => ({
        catalog: null,
        source: 'missing',
        status: 'missing',
        error: 'network',
      }),
    }),
  ).rejects.toThrow('aio-proxy server required');
});

test('login rejects a missing incompatible schema with the upgrade diagnostic', async () => {
  await expect(
    loginPiFamily(managed, () => {}, {
      requestDeviceAuthorization: async () => ({
        device_code: 'device-code',
        user_code: 'ABCD-EFGH',
        verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
        verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
        expires_in: 600,
        interval: 5,
      }),
      pollDeviceAuthorization: async () => ({
        token_type: 'Bearer',
        access_token: 'aio_agent_at_v1_access',
        refresh_token: 'aio_agent_rt_v1_refresh',
        expires_in: 900,
      }),
      refreshAgentCatalog: async () => ({
        catalog: null,
        source: 'missing',
        status: 'missing',
        error: 'unsupported_schema',
      }),
    }),
  ).rejects.toThrow('aio-proxy adapter upgrade required');
});

test('undefined access token rereads LKG without a catalog request', async () => {
  const refresh = mock(async () => {
    throw new Error('network must not run');
  });
  await expect(
    readPiFamilyModels(managed, undefined, {
      readLastKnownCatalog: async () => catalog,
      refreshAgentCatalog: refresh,
    }),
  ).resolves.toEqual({
    models: toPiFamilyModels(catalog),
    source: 'lkg',
    status: 'stale',
  });
  expect(refresh).not.toHaveBeenCalled();
});

test('undefined access token without LKG is missing and does not touch the network', async () => {
  const refresh = mock(async () => {
    throw new Error('network must not run');
  });
  await expect(
    readPiFamilyModels(managed, undefined, {
      readLastKnownCatalog: async () => null,
      refreshAgentCatalog: refresh,
    }),
  ).resolves.toEqual({ models: [], source: 'missing', status: 'missing' });
  expect(refresh).not.toHaveBeenCalled();
});
