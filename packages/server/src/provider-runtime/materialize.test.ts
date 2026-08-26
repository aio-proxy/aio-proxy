import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AiSdkProviderInstance, ApiProviderInstance } from '@aio-proxy/core';
import { createApiProvider } from '@aio-proxy/core';
import type { Provider } from '@aio-proxy/types';
import { ConfigSchema, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import { withAttemptLogContext, withRequestLogContext } from '../request-logging';
import type { RuntimeProviderInstance } from '../runtime';
import { supportsImage, supportsLanguage } from './capability-index';
import { materializeProviders, materializeRuntimeProvider, providerSummary } from './materialize';

const headerSet = (field: string, value: unknown) => ({
  $setField: { field, input: '$request.headers', value },
});

function withModelAttempt<T>(
  providerId: string,
  modelId: string,
  sourceProtocol: ProviderProtocol,
  targetProtocol: ProviderProtocol | undefined,
  operation: () => T,
): T {
  return withRequestLogContext({ requestId: 'request', debug: false, logger: () => {} }, () =>
    withAttemptLogContext(
      {
        attemptIndex: 0,
        providerId,
        modelId,
        requestedModelId: 'client-model',
        sourceProtocol,
        ...(targetProtocol === undefined ? {} : { targetProtocol }),
      },
      operation,
    ),
  );
}

function assertRuntimeProviderRequiresCapability(provider: AiSdkProviderInstance): void {
  // @ts-expect-error a materialized runtime provider must expose raw, model, image, or embedding
  const runtime: RuntimeProviderInstance = provider;
  void runtime;
}
void assertRuntimeProviderRequiresCapability;

test('attaches embedding convert when an OpenAI-compatible API bridge exposes embed', () => {
  const embed = async () => ({ embeddings: [[0.1]] });
  const config = ConfigSchema.parse({
    providers: {
      api: {
        baseURL: 'https://api.example.com',
        kind: ProviderKind.Api,
        models: ['text-embedding-3-small'],
        protocol: ProviderProtocol.OpenAICompatible,
      },
    },
  });

  const runtime = materializeProviders(config, {
    bridgeApiProvider() {
      return {
        enabled: true,
        id: 'api:bridge',
        kind: ProviderKind.AiSdk,
        invoke: () => new ReadableStream(),
        embed,
      } satisfies AiSdkProviderInstance;
    },
  });

  expect(runtime.providers[0]?.embedding?.embed).toBe(embed);
});

test('attaches embedding convert when a Gemini API bridge exposes embed', () => {
  const embed = async () => ({ embeddings: [[0.2]] });
  const config = ConfigSchema.parse({
    providers: {
      api: {
        baseURL: 'https://generativelanguage.googleapis.com/v1beta',
        kind: ProviderKind.Api,
        models: ['gemini-embedding-001'],
        protocol: ProviderProtocol.Gemini,
      },
    },
  });

  const runtime = materializeProviders(config, {
    bridgeApiProvider() {
      return {
        enabled: true,
        id: 'api:bridge',
        kind: ProviderKind.AiSdk,
        invoke: () => new ReadableStream(),
        embed,
      } satisfies AiSdkProviderInstance;
    },
  });

  expect(runtime.providers[0]?.embedding?.embed).toBe(embed);
});

test('attaches embedding convert when an AI SDK instance exposes embed', () => {
  const embed = async () => ({ embeddings: [[0.3]] });
  const runtime = materializeRuntimeProvider({
    enabled: true,
    embed,
    id: 'sdk',
    invoke: () => new ReadableStream(),
    kind: ProviderKind.AiSdk,
  } satisfies AiSdkProviderInstance);

  expect(runtime.embedding?.embed).toBe(embed);
});

test('omits embedding convert when an Anthropic-primary API provider has no embeddingModel', () => {
  const config = ConfigSchema.parse({
    providers: {
      api: {
        baseURL: 'https://api.anthropic.com',
        kind: ProviderKind.Api,
        models: ['claude-sonnet-4-0'],
        protocol: ProviderProtocol.Anthropic,
      },
    },
  });

  const runtime = materializeProviders(config);

  expect(runtime.providers[0]?.embedding).toBeUndefined();
});

test('materializes a configured API provider with raw and bridged model capabilities once', () => {
  const config = ConfigSchema.parse({
    providers: {
      api: {
        baseURL: 'https://api.example.com',
        kind: ProviderKind.Api,
        models: ['model'],
        protocol: ProviderProtocol.OpenAICompatible,
      },
    },
  });
  const bridge = {
    enabled: true,
    id: 'api:bridge',
    kind: ProviderKind.AiSdk,
    invoke: () => new ReadableStream(),
  } satisfies AiSdkProviderInstance;
  let bridgeCalls = 0;

  const runtime = materializeProviders(config, {
    bridgeApiProvider(provider) {
      bridgeCalls += 1;
      expect(provider.id).toBe('api');
      return bridge;
    },
  });

  expect(bridgeCalls).toBe(1);
  expect(
    runtime.providers[0]?.raw?.resolve({
      protocol: ProviderProtocol.OpenAICompatible,
      modelId: 'test',
    }),
  ).toBeDefined();
  expect(runtime.providers[0]?.model?.invoke).toBe(bridge.invoke);
});

test('chat-primary API models[] ids support language without a catalog', () => {
  const config = ConfigSchema.parse({
    providers: {
      api: {
        baseURL: 'https://api.example.com',
        kind: ProviderKind.Api,
        models: ['gpt-5'],
        protocol: ProviderProtocol.OpenAICompatible,
      },
    },
  });

  const provider = materializeProviders(config).providers[0];

  expect(supportsLanguage(provider!.capabilityIndex, 'gpt-5')).toBe(true);
  expect(supportsImage(provider!.capabilityIndex, 'gpt-5')).toBe(false);
});

test('materializes an enabled image-only API provider without a language transport', () => {
  const config = ConfigSchema.parse({
    providers: {
      images: {
        baseURL: 'https://api.openai.com/v1',
        kind: ProviderKind.Api,
        models: ['gpt-image-2'],
        protocol: ProviderProtocol.OpenAIImage,
      },
    },
  });

  const runtime = materializeProviders(config);
  const provider = runtime.providers[0];

  expect(provider?.raw).toBeDefined();
  expect(provider?.image).toBeDefined();
  expect(provider?.model).toBeUndefined();
  expect(supportsImage(provider!.capabilityIndex, 'gpt-image-2')).toBe(true);
  expect(supportsLanguage(provider!.capabilityIndex, 'gpt-image-2')).toBe(false);
  expect(provider?.raw?.resolve({ protocol: ProviderProtocol.OpenAIImage, modelId: 'gpt-image-2' })).toBeDefined();
});

test('api provider raw capability resolves any declared endpoint protocol', () => {
  const api = createApiProvider(
    {
      apiKey: 'k',
      baseURL: 'https://api.moonshot.cn/v1',
      enabled: true,
      id: 'moonshot',
      kind: ProviderKind.Api,
      models: ['kimi-k2'],
      protocol: ProviderProtocol.OpenAICompatible,
      endpoints: [{ protocol: ProviderProtocol.Anthropic, baseURL: 'https://api.moonshot.cn/anthropic/v1' }],
    },
    { fetch: (async () => new Response('{}')) as typeof globalThis.fetch },
  );
  const instance = materializeRuntimeProvider(api);

  expect(instance.raw?.resolve({ protocol: ProviderProtocol.OpenAICompatible, modelId: 'kimi-k2' })).toBeDefined();
  expect(instance.raw?.resolve({ protocol: ProviderProtocol.Anthropic, modelId: 'kimi-k2' })).toBeDefined();
  expect(instance.raw?.resolve({ protocol: ProviderProtocol.Gemini, modelId: 'kimi-k2' })).toBeUndefined();
});

test('summarizes an endpoints-only api provider with its primary endpoint protocol', () => {
  const config = {
    apiKey: 'k',
    enabled: true,
    endpoints: [
      { protocol: ProviderProtocol.Anthropic, baseURL: 'https://api.z.ai/api/anthropic/v1' },
      { protocol: ProviderProtocol.OpenAICompatible, baseURL: 'https://api.z.ai/api/paas/v4' },
    ],
    id: 'zai',
    kind: ProviderKind.Api,
    models: ['glm-4.7'],
  } satisfies Provider;
  const instance = materializeRuntimeProvider(
    createApiProvider(config, { fetch: (async () => new Response('{}')) as typeof globalThis.fetch }),
  );

  expect(providerSummary(instance, undefined, config)).toMatchObject({ protocol: ProviderProtocol.Anthropic });
});

test('materializes API metadata into the config layer only', () => {
  const config = ConfigSchema.parse({
    providers: {
      api: {
        kind: 'api',
        protocol: 'openai-compatible',
        baseURL: 'https://api.example.com',
        models: ['model'],
        metadata: { model: { name: 'Configured', cost: { input: 2 } } },
      },
    },
  });

  const provider = materializeProviders(config).providers[0];
  expect(provider?.configMetadata?.model).toMatchObject({ name: 'Configured', cost: { input: 2 } });
  expect(provider?.upstreamMetadata).toBeUndefined();
});

test('materializes AI SDK metadata into the config layer only', () => {
  const config = ConfigSchema.parse({
    providers: {
      sdk: {
        kind: 'ai-sdk',
        packageName: '@ai-sdk/openai-compatible',
        models: ['model'],
        metadata: { model: { name: 'Configured', cost: { input: 2 } } },
      },
    },
  });

  const provider = materializeProviders(config, {
    createAiSdkProvider: (configured) => ({ ...configured, invoke: () => new ReadableStream() }),
  }).providers[0];
  expect(provider?.configMetadata?.model).toMatchObject({ name: 'Configured', cost: { input: 2 } });
  expect(provider?.upstreamMetadata).toBeUndefined();
});

test('materializes and summarizes normalized Provider routing defaults', () => {
  const config = ConfigSchema.parse({
    providers: {
      api: { kind: 'api', protocol: 'openai-compatible', baseURL: 'https://api.test', priority: 7, weight: 2.6 },
    },
  });
  const runtime = materializeProviders(config, {
    createApiProvider: (provider) => {
      const passthrough = async () => new Response();
      return {
        ...provider,
        endpointTransports: [{ protocol: provider.protocol, passthrough }],
        passthrough,
      };
    },
    bridgeApiProvider: () => ({
      enabled: true,
      id: 'api:bridge',
      invoke: () => new ReadableStream(),
      kind: ProviderKind.AiSdk,
    }),
  });
  expect(runtime.providers[0]).toMatchObject({ priority: 7, weight: 3 });
  expect(runtime.summaries[0]).toMatchObject({ priority: 7, weight: 3 });
});

test('copies normalized routing defaults onto AI SDK runtime providers and summaries', () => {
  const config = ConfigSchema.parse({
    providers: {
      sdk: {
        kind: 'ai-sdk',
        packageName: '@ai-sdk/openai-compatible',
        models: ['model'],
        priority: 4,
        weight: 8.4,
      },
    },
  });
  const runtime = materializeProviders(config, {
    createAiSdkProvider: (provider) => ({
      enabled: provider.enabled,
      id: provider.id,
      invoke: () => new ReadableStream(),
      kind: ProviderKind.AiSdk,
      models: provider.models,
    }),
  });
  expect(runtime.providers[0]).toMatchObject({ priority: 4, weight: 8 });
  expect(runtime.summaries[0]).toMatchObject({ priority: 4, weight: 8 });
});

test('provider summaries preserve configured weight and truthful display identity', () => {
  const config = ConfigSchema.parse({
    providers: {
      api: {
        baseURL: 'https://api.example.com',
        kind: ProviderKind.Api,
        models: ['api-model'],
        protocol: ProviderProtocol.Anthropic,
        weight: 9,
      },
      sdk: {
        kind: ProviderKind.AiSdk,
        models: ['sdk-model'],
        packageName: '@ai-sdk/anthropic',
        weight: 0,
      },
    },
  });

  const runtime = materializeProviders(config, {
    createApiProvider: (provider) => {
      const passthrough = () => Promise.resolve(new Response());
      return { ...provider, endpointTransports: [{ protocol: provider.protocol, passthrough }], passthrough };
    },
    bridgeApiProvider: () => ({
      enabled: true,
      id: 'api:bridge',
      invoke: () => new ReadableStream(),
      kind: ProviderKind.AiSdk,
    }),
    createAiSdkProvider: (provider) => ({
      enabled: provider.enabled,
      id: provider.id,
      invoke: () => new ReadableStream(),
      kind: ProviderKind.AiSdk,
      models: provider.models,
    }),
  });
  const api = runtime.summaries.find((provider) => provider.id === 'api');
  const sdk = runtime.summaries.find((provider) => provider.id === 'sdk');

  expect(api).toMatchObject({ weight: 9, protocol: ProviderProtocol.Anthropic });
  expect(api).not.toHaveProperty('packageName');
  expect(sdk).toMatchObject({ weight: 0, packageName: '@ai-sdk/anthropic' });
  expect(sdk).not.toHaveProperty('protocol');
});

test('materializes one transformed Fetch for raw API, API bridge, and direct AI SDK model traffic', async () => {
  const config = ConfigSchema.parse({
    providers: {
      api: {
        baseURL: 'https://api.example.com',
        kind: ProviderKind.Api,
        models: ['api-model'],
        protocol: ProviderProtocol.OpenAICompatible,
        transforms: {
          request: [
            {
              update: [
                { $set: { 'request.headers': headerSet('x-provider-route', 'api') } },
                { $set: { 'request.body.route': 'api' } },
              ],
            },
          ],
        },
      },
      sdk: {
        kind: ProviderKind.AiSdk,
        models: ['sdk-model'],
        packageName: '@ai-sdk/openai-compatible',
        transforms: {
          request: [
            {
              update: [
                { $set: { 'request.headers': headerSet('x-provider-route', 'sdk') } },
                { $set: { 'request.body.route': 'sdk' } },
              ],
            },
          ],
        },
      },
    },
  });
  const baseCalls: Request[][] = [];
  let apiFetch: typeof globalThis.fetch | undefined;
  let bridgeFetch: typeof globalThis.fetch | undefined;
  let sdkFetch: typeof globalThis.fetch | undefined;
  const runtime = materializeProviders(config, {
    createProxyFetch() {
      const calls: Request[] = [];
      baseCalls.push(calls);
      return (async (input, init) => {
        calls.push(input instanceof Request ? input : new Request(input, init));
        return Response.json({ ok: true });
      }) as typeof globalThis.fetch;
    },
    createApiProvider(provider, options) {
      apiFetch = options.fetch;
      const passthrough = (request: Request) => options.fetch(request);
      return {
        ...provider,
        endpointTransports: [{ protocol: provider.protocol, passthrough }],
        passthrough,
      } satisfies ApiProviderInstance;
    },
    bridgeApiProvider(provider, options) {
      bridgeFetch = options.fetch;
      return {
        enabled: true,
        id: `${provider.id}:bridge`,
        invoke: () => new ReadableStream(),
        kind: ProviderKind.AiSdk,
      } satisfies AiSdkProviderInstance;
    },
    createAiSdkProvider(provider, options) {
      sdkFetch = options.fetch;
      return {
        enabled: true,
        id: provider.id,
        invoke: () => new ReadableStream(),
        kind: ProviderKind.AiSdk,
      } satisfies AiSdkProviderInstance;
    },
  });
  const api = runtime.providers.find(({ id }) => id === 'api');
  const raw = api?.raw?.resolve({ protocol: ProviderProtocol.OpenAICompatible, modelId: 'api-model' });
  if (raw === undefined || bridgeFetch === undefined || sdkFetch === undefined)
    throw new Error('missing fetch fixture');

  await withModelAttempt('api', 'api-model', ProviderProtocol.OpenAICompatible, ProviderProtocol.OpenAICompatible, () =>
    raw.invoke(
      new Request('https://api.example.com/v1/chat/completions', {
        body: '{"route":"client"}',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      { session: { key: 'session' } } as never,
    ),
  );
  await withModelAttempt('api', 'api-model', ProviderProtocol.OpenAIResponse, ProviderProtocol.OpenAICompatible, () =>
    bridgeFetch!('https://api.example.com/v1/chat/completions', {
      body: '{"route":"client"}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
  );
  await withModelAttempt('sdk', 'sdk-model', ProviderProtocol.OpenAIResponse, ProviderProtocol.OpenAICompatible, () =>
    sdkFetch!('https://sdk.example.com/v1/chat/completions', {
      body: '{"route":"client"}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
  );

  expect(apiFetch).toBe(bridgeFetch);
  expect(baseCalls.map((calls) => calls.length)).toEqual([2, 1]);
  expect(baseCalls[0]?.map((request) => request.headers.get('x-provider-route'))).toEqual(['api', 'api']);
  expect(baseCalls[1]?.map((request) => request.headers.get('x-provider-route'))).toEqual(['sdk']);
  expect(await Promise.all(baseCalls.flat().map((request) => request.json()))).toEqual([
    { route: 'api' },
    { route: 'api' },
    { route: 'sdk' },
  ]);
});

test('materializes AI SDK inputs with model capabilities only', () => {
  const ensureAvailable = async () => {};
  const invoke = () => new ReadableStream();
  const aiSdk = {
    enabled: true,
    ensureAvailable,
    id: 'ai-sdk',
    invoke,
    kind: ProviderKind.AiSdk,
  } satisfies AiSdkProviderInstance;
  const aiSdkRuntime = materializeRuntimeProvider(aiSdk);

  expect(aiSdkRuntime.raw).toBeUndefined();
  expect(aiSdkRuntime.model).toEqual({ ensureAvailable, invoke });
  expect(aiSdkRuntime).not.toHaveProperty('priority');
  expect(aiSdkRuntime).not.toHaveProperty('weight');
});

test('rejects an injected runtime provider without raw, model, image, or embedding capabilities', () => {
  expect(() =>
    materializeRuntimeProvider({
      enabled: true,
      id: 'invalid',
      kind: ProviderKind.OAuth,
    } as never),
  ).toThrow('must expose a raw, model, image, or embedding capability');
});

test('materializes an API input whose raw placeholder is undefined', async () => {
  let upstreamStream: boolean | undefined;
  const passthrough = async (_request: Request, options?: { readonly upstreamStream: boolean }) => {
    upstreamStream = options?.upstreamStream;
    return new Response();
  };
  const provider = {
    baseURL: 'https://api.example.com',
    enabled: true,
    endpointTransports: [{ protocol: ProviderProtocol.Anthropic, passthrough }],
    id: 'api-placeholder',
    kind: ProviderKind.Api,
    passthrough,
    protocol: ProviderProtocol.Anthropic,
    raw: undefined,
  } satisfies ApiProviderInstance & { readonly raw: undefined };

  const runtime = materializeRuntimeProvider(provider);

  expect(runtime).not.toBe(provider);
  const raw = runtime.raw?.resolve({ protocol: ProviderProtocol.Anthropic, modelId: 'test' });
  expect(raw?.invoke).not.toBe(passthrough);
  await raw?.invoke(new Request('https://proxy.test/v1/messages'), undefined, { upstreamStream: false });
  expect(upstreamStream).toBe(false);
  expect(runtime.model).toBeUndefined();
});

test('materializes an AI SDK input whose model placeholder is undefined', () => {
  const invoke = () => new ReadableStream();
  const provider = {
    enabled: true,
    id: 'model-placeholder',
    invoke,
    kind: ProviderKind.AiSdk,
    model: undefined,
  } satisfies AiSdkProviderInstance & { readonly model: undefined };

  const runtime = materializeRuntimeProvider(provider);

  expect(runtime).not.toBe(provider);
  expect(runtime.raw).toBeUndefined();
  expect(runtime.model).toEqual({ invoke });
});

test('materializes an AI SDK input instead of accepting an inherited model capability', () => {
  const invoke = () => new ReadableStream();
  const inheritedModel = { invoke };
  const provider = Object.assign(Object.create({ model: inheritedModel }) as AiSdkProviderInstance, {
    enabled: true,
    id: 'inherited-model',
    invoke,
    kind: ProviderKind.AiSdk,
  });

  const runtime = materializeRuntimeProvider(provider);

  expect(runtime).not.toBe(provider);
  expect(runtime.model).not.toBe(inheritedModel);
  expect(runtime.model?.invoke).toBe(invoke);
});

test('materializes an injected API test double without baseURL through the snapshot seam', async () => {
  let invoked = false;
  const passthrough = async () => {
    invoked = true;
    return new Response();
  };
  const provider = {
    enabled: true,
    endpointTransports: [{ protocol: ProviderProtocol.Anthropic, passthrough }],
    id: 'api-double',
    kind: ProviderKind.Api,
    passthrough,
    protocol: ProviderProtocol.Anthropic,
  } satisfies Omit<ApiProviderInstance, 'baseURL'>;
  const dbHome = mkdtempSync(join(tmpdir(), 'aio-proxy-provider-capabilities-'));
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    dbHome,
    providerInstances: [provider as unknown as ApiProviderInstance],
  });

  try {
    const runtime = state.currentProviderSnapshot().providers[0];

    const raw = runtime?.raw?.resolve({ protocol: ProviderProtocol.Anthropic, modelId: 'test' });
    await raw?.invoke(new Request('https://proxy.test/v1/messages'));
    expect(invoked).toBe(true);
    expect(runtime?.model).toBeUndefined();
  } finally {
    state.close();
    rmSync(dbHome, { force: true, recursive: true });
  }
});

test('returns an already materialized provider unchanged', () => {
  const invoke = () => new ReadableStream();
  const provider = {
    capabilityIndex: { ready: new Set(['language']) },
    enabled: true,
    id: 'ready',
    invoke,
    kind: ProviderKind.AiSdk,
    model: { invoke },
  } satisfies RuntimeProviderInstance;

  expect(materializeRuntimeProvider(provider)).toBe(provider);
});

test('keeps the model capability reference stable across snapshot reads', async () => {
  const dbHome = mkdtempSync(join(tmpdir(), 'aio-proxy-provider-capabilities-'));
  const provider = {
    enabled: true,
    id: 'stable',
    invoke: () => new ReadableStream(),
    kind: ProviderKind.AiSdk,
  } satisfies AiSdkProviderInstance;
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    dbHome,
    providerInstances: [provider],
  });

  try {
    const first = state.currentProviderSnapshot().providers[0]?.model;
    const second = state.currentProviderSnapshot().providers[0]?.model;

    expect(second).toBe(first);
  } finally {
    state.close();
    rmSync(dbHome, { force: true, recursive: true });
  }
});

test('replaces the model capability object only after config reload', async () => {
  const dbHome = mkdtempSync(join(tmpdir(), 'aio-proxy-provider-capabilities-'));
  const configPath = join(dbHome, 'config.json');
  const config = ConfigSchema.parse({
    providers: {
      api: {
        baseURL: 'https://before.example.com',
        kind: ProviderKind.Api,
        models: ['model'],
        protocol: ProviderProtocol.OpenAICompatible,
      },
    },
  });
  writeFileSync(configPath, JSON.stringify(config));
  const state = await createServerState({ config, configPath, dbHome, watchConfig: false });

  try {
    const before = state.currentProviderSnapshot().providers[0]?.model;
    expect(state.currentProviderSnapshot().providers[0]?.model).toBe(before);

    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          api: {
            baseURL: 'https://after.example.com',
            kind: ProviderKind.Api,
            models: ['model'],
            protocol: ProviderProtocol.OpenAICompatible,
          },
        },
      }),
    );
    expect((await state.reload()).ok).toBe(true);

    expect(state.currentProviderSnapshot().providers[0]?.model).not.toBe(before);
  } finally {
    state.close();
    rmSync(dbHome, { force: true, recursive: true });
  }
});

test('does not materialize configured providers before building an injected snapshot', async () => {
  const config = ConfigSchema.parse({
    providers: {
      configured: {
        baseURL: 'https://configured.example.com',
        kind: ProviderKind.Api,
        models: ['configured-model'],
        protocol: ProviderProtocol.OpenAICompatible,
      },
    },
  });
  const configured = config.providers[0];
  if (configured === undefined) {
    throw new Error('configured provider is missing');
  }
  let baseURLReads = 0;
  Object.defineProperty(configured, 'baseURL', {
    configurable: true,
    enumerable: true,
    get() {
      baseURLReads += 1;
      return 'https://configured.example.com';
    },
  });
  const provider = {
    enabled: true,
    id: 'injected',
    invoke: () => new ReadableStream(),
    kind: ProviderKind.AiSdk,
  } satisfies AiSdkProviderInstance;
  const dbHome = mkdtempSync(join(tmpdir(), 'aio-proxy-provider-capabilities-'));
  const state = await createServerState({ config, dbHome, providerInstances: [provider] });

  try {
    expect(baseURLReads).toBe(0);
    const snapshot = state.currentProviderSnapshot();
    const summaries = await state.providerSummaries({ probe: false });
    expect(snapshot.providers.map((entry) => entry.id)).toEqual(['injected']);
    expect(snapshot.providerStates?.get('injected')).toBe(summaries[0]?.state);
  } finally {
    state.close();
    rmSync(dbHome, { force: true, recursive: true });
  }
});
