import { afterEach, expect, test } from 'bun:test';

import type { LogicalRequestContext, RawResolver, RawTransportOptions } from '@aio-proxy/plugin-sdk';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { oauthExposedModels } from '@aio-proxy/types';

import { supportsEmbedding, supportsImage } from '../provider-runtime/capability-index';
import { withRoutingConfig } from './capabilities';
import { PluginRawResolverError, PluginRawTransportError, validatePluginProtocolMap } from './index';
import { catalog, cleanup, diagnostics, materializePluginProvider, runtimeFixture } from './test-support';

afterEach(cleanup);

const providerConfig = {
  id: 'person',
  kind: ProviderKind.OAuth,
  enabled: true,
  plugin: '@example/oauth',
  capability: 'default',
} as const;

const providerV4 = () => ({
  specificationVersion: 'v4' as const,
  languageModel() {
    throw new Error('not called');
  },
  imageModel() {
    throw new Error('not called');
  },
  embeddingModel() {
    throw new Error('not called');
  },
});

const materializeFixture = (fixture: ReturnType<typeof runtimeFixture>) =>
  materializePluginProvider({
    config: providerConfig,
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  });

test('maps every internal provider protocol to the plugin SDK protocol', () => {
  expect(validatePluginProtocolMap()).toEqual({
    [ProviderProtocol.OpenAICompatible]: 'openai-compatible',
    [ProviderProtocol.OpenAIResponse]: 'openai-response',
    [ProviderProtocol.Anthropic]: 'anthropic',
    [ProviderProtocol.Gemini]: 'gemini',
    [ProviderProtocol.GeminiInteractions]: 'gemini-interactions',
    [ProviderProtocol.OpenAIImage]: 'openai-image',
  });
});

test('rejects an array runtime carrying a provider property', async () => {
  const runtime = Object.assign([], { provider: providerV4() });
  const fixture = runtimeFixture({ kind: 'static' }, { createRuntime: async () => runtime as never });

  const result = await materializeFixture(fixture);

  expect(result.provider).toBeUndefined();
  expect(result.state).toMatchObject({ status: 'unavailable', diagnostic: { code: 'RUNTIME_CREATE_FAILED' } });
});

test('rejects an array raw transport carrying an invoke property', async () => {
  const transport = Object.assign([], { invoke: async () => new Response('ok') });
  const fixture = runtimeFixture(
    { kind: 'static' },
    {
      createRuntime: async () => ({ provider: providerV4(), raw: () => transport as never }),
    },
  );

  const result = await materializeFixture(fixture);

  expect(() =>
    result.provider?.raw?.resolve({ protocol: ProviderProtocol.OpenAICompatible, modelId: 'model' }),
  ).toThrow(PluginRawResolverError);
});

test('plugin raw capability receives catalog extra and rejects malformed transports', async () => {
  const modelId = 'model';
  const observed: unknown[] = [];
  const fixture = runtimeFixture(
    { kind: 'static' },
    {
      catalog: {
        ...catalog,
        language: [{ id: 'model', displayName: 'Catalog Name', extra: { region: 'us', protocol: 'anthropic' } }],
      },
      createRuntime: async () =>
        ({
          provider: providerV4(),
          raw(input: Parameters<RawResolver>[0]) {
            observed.push(input);
            if (input.modelId === 'bad-resolver') return { invoke: 'invalid' } as never;
            if (input.modelId === 'bad-response') return { invoke: async () => ({}) } as never;
            return { invoke: async () => new Response('ok') };
          },
        }) as never,
    },
  );
  fixture.repository.writeCatalog(
    'person',
    {
      ...catalog,
      language: [
        { id: 'model', displayName: 'Catalog Name', extra: { region: 'us', protocol: 'anthropic' } },
        { id: 'bad-resolver' },
        { id: 'bad-response' },
      ],
    },
    1_000,
  );
  const result = await materializePluginProvider({
    config: {
      id: 'person',
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: '@example/oauth',
      capability: 'default',
      alias: { client: { model: 'model', preserve: false } },
    },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  });

  const transport = result.provider?.raw?.resolve({ protocol: ProviderProtocol.OpenAICompatible, modelId: 'model' });
  expect(await transport?.invoke(new Request('https://example.test'))).toBeInstanceOf(Response);
  expect(observed[0]).toEqual({
    protocol: 'openai-compatible',
    modelId: 'model',
    extra: { region: 'us', protocol: 'anthropic' },
  });
  result.provider?.raw?.resolve({
    protocol: ProviderProtocol.OpenAICompatible,
    modelId: 'model',
    requestPath: '/v1/completions',
  });
  expect(observed[1]).toEqual({
    protocol: 'openai-compatible',
    modelId: 'model',
    extra: { region: 'us', protocol: 'anthropic' },
    requestPath: '/v1/completions',
  });
  expect(result.provider?.upstreamMetadata?.[modelId]).toEqual({
    name: 'Catalog Name',
    protocol: ProviderProtocol.Anthropic,
  });
  expect(result.provider?.model?.targetProtocol?.(modelId)).toBe(ProviderProtocol.Anthropic);
  expect(result.summary.clientModels).toEqual(['bad-resolver', 'bad-response', 'client']);
  expect(() =>
    result.provider?.raw?.resolve({ protocol: ProviderProtocol.OpenAICompatible, modelId: 'bad-resolver' }),
  ).toThrow(PluginRawResolverError);
  const badResponse = result.provider?.raw?.resolve({
    protocol: ProviderProtocol.OpenAICompatible,
    modelId: 'bad-response',
  });
  await expect(badResponse?.invoke(new Request('https://example.test'))).rejects.toBeInstanceOf(
    PluginRawTransportError,
  );
});

test('forwards raw transport options through the plugin runtime boundary', async () => {
  let upstreamStream: boolean | undefined;
  const fixture = runtimeFixture(
    { kind: 'static' },
    {
      createRuntime: async () => ({
        provider: providerV4(),
        raw: () => ({
          invoke: async (
            _request: Request,
            _context: LogicalRequestContext | undefined,
            options?: RawTransportOptions,
          ) => {
            upstreamStream = options?.upstreamStream;
            return Response.json({ ok: true });
          },
        }),
      }),
    },
  );

  const result = await materializeFixture(fixture);
  const transport = result.provider?.raw?.resolve({
    protocol: ProviderProtocol.OpenAICompatible,
    modelId: 'model',
  });

  expect(
    await transport?.invoke(new Request('https://example.test'), undefined, { upstreamStream: true }),
  ).toBeInstanceOf(Response);
  expect(upstreamStream).toBe(true);
});

test('materializes an optional plugin token-count capability', async () => {
  const fixture = runtimeFixture(
    { kind: 'static' },
    {
      createRuntime: async () => ({
        provider: providerV4(),
        tokenCount: { countTokens: async () => ({ inputTokens: 13 }) },
      }),
    },
  );

  const result = await materializeFixture(fixture);
  const input = {
    protocol: 'anthropic' as const,
    modelId: 'model',
    request: new Request('https://proxy.test/v1/messages/count_tokens'),
    context: { requestId: 'request', session: { key: 'sha256:test' as const, source: 'transcript' as const } },
    invocation: { messages: [{ role: 'user' as const, content: 'hello' }] },
  };

  expect(await result.provider?.tokenCount?.countTokens(input)).toEqual({ inputTokens: 13 });
});

test('materializes a class-based plugin token-count capability', async () => {
  class TokenCount {
    async countTokens() {
      return { inputTokens: 17 };
    }
  }
  const fixture = runtimeFixture(
    { kind: 'static' },
    {
      createRuntime: async () => ({
        provider: providerV4(),
        tokenCount: new TokenCount(),
      }),
    },
  );

  const result = await materializeFixture(fixture);
  const input = {
    protocol: 'anthropic' as const,
    modelId: 'model',
    request: new Request('https://proxy.test/v1/messages/count_tokens'),
    context: { requestId: 'request', session: { key: 'sha256:test' as const, source: 'transcript' as const } },
    invocation: { messages: [{ role: 'user' as const, content: 'hello' }] },
  };

  expect(await result.provider?.tokenCount?.countTokens(input)).toEqual({ inputTokens: 17 });
});

test('oauthExposedModels: absent or empty excludedModels exposes the whole catalog', () => {
  expect(oauthExposedModels(['a', 'b'], undefined)).toEqual(['a', 'b']);
  expect(oauthExposedModels(['a', 'b'], [])).toEqual(['a', 'b']);
});

test('oauthExposedModels: a denylist subtracts from the catalog and ignores stale ids', () => {
  expect(oauthExposedModels(['a', 'b', 'c'], ['b', 'gone'])).toEqual(['a', 'c']);
});

test('a denylist filters the freshly materialized catalog', async () => {
  const fixture = runtimeFixture({ kind: 'static' }, { createRuntime: async () => ({ provider: providerV4() }) });
  fixture.repository.writeCatalog('person', { ...catalog, language: [{ id: 'model' }, { id: 'other' }] }, 1_000);

  const result = await materializePluginProvider({
    config: { ...providerConfig, excludedModels: ['other'] },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  });

  expect(result.provider?.models).toEqual(['model']);
  expect(Object.keys(result.provider?.upstreamMetadata ?? {})).toEqual(['model']);
  expect(result.summary.clientModels).not.toContain('other');
});

test('changing only the denylist keeps runtime identity stable and takes the cached routing path', async () => {
  const fixture = runtimeFixture({ kind: 'static' }, { createRuntime: async () => ({ provider: providerV4() }) });
  fixture.repository.writeCatalog('person', { ...catalog, language: [{ id: 'model' }, { id: 'other' }] }, 1_000);

  const first = await materializeFixture(fixture);
  expect(first.provider?.models).toEqual(['model', 'other']);

  const second = await materializePluginProvider({
    config: { ...providerConfig, excludedModels: ['other'] },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    previous: first.cacheEntry,
  });

  expect(second.cacheEntry?.identity).toBe(first.cacheEntry?.identity);
  expect(second.provider?.models).toEqual(['model']);

  const third = await materializePluginProvider({
    config: providerConfig,
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    previous: second.cacheEntry,
  });

  expect(third.provider?.models).toEqual(['model', 'other']);
});

test('withRoutingConfig re-derives models from the unfiltered catalog ids', () => {
  const cached = {
    id: 'person',
    kind: ProviderKind.OAuth,
    enabled: true,
    models: ['a'],
    model: {
      invoke: () => {
        throw new Error('unused');
      },
    },
  } as never;

  const next = withRoutingConfig(cached, { ...providerConfig, excludedModels: ['a'] } as never, {
    ...catalog,
    language: [{ id: 'a' }, { id: 'b' }],
  });

  expect(next.models).toEqual(['b']);
});

test('withRoutingConfig rebuilds capabilityIndex when catalog.image gains an id', () => {
  const cached = {
    id: 'person',
    kind: ProviderKind.OAuth,
    enabled: true,
    models: ['gpt-5'],
    capabilityIndex: { 'gpt-5': new Set(['language']) },
    model: {
      invoke: () => {
        throw new Error('unused');
      },
    },
  } as never;

  const next = withRoutingConfig(cached, providerConfig as never, {
    ...catalog,
    language: [{ id: 'gpt-5' }],
    image: [{ id: 'gpt-image-2' }],
  });

  expect(supportsImage(next.capabilityIndex, 'gpt-image-2')).toBe(true);
});

test('withRoutingConfig does not restore denylist-excluded catalog ids through upstreamMetadata', () => {
  const cached = {
    id: 'person',
    kind: ProviderKind.OAuth,
    enabled: true,
    models: ['gpt-5'],
    capabilityIndex: { 'gpt-5': new Set(['language']) },
    model: {
      invoke: () => {
        throw new Error('unused');
      },
    },
  } as never;

  const next = withRoutingConfig(cached, { ...providerConfig, excludedModels: ['other'] } as never, {
    ...catalog,
    language: [{ id: 'gpt-5' }, { id: 'other' }],
    image: [{ id: 'gpt-image-2' }],
  });

  expect(next.models).toEqual(['gpt-5', 'gpt-image-2']);
  expect(Object.keys(next.upstreamMetadata ?? {})).toEqual(['gpt-5', 'gpt-image-2']);
  expect(supportsImage(next.capabilityIndex, 'gpt-image-2')).toBe(true);
});

test('inherited preserve cannot re-admit an excluded catalog id', () => {
  const cached = {
    id: 'person',
    kind: ProviderKind.OAuth,
    enabled: true,
    models: ['visible'],
    model: {
      invoke: () => {
        throw new Error('unused');
      },
    },
  } as never;

  const next = withRoutingConfig(
    cached,
    { ...providerConfig, excludedModels: ['hidden'] } as never,
    { ...catalog, language: [{ id: 'visible' }, { id: 'hidden' }] },
    { keep: { model: 'hidden', preserve: true } },
  );

  expect(next.models).toEqual(['visible']);
  expect(next.alias).toBeUndefined();
  expect(next.upstreamMetadata).not.toHaveProperty('hidden');
});

test('a language catalog attaches a lazy image invoke even when catalog.image is empty', async () => {
  // Router metadata may grant image output to language models at request
  // time; the invoke must already exist on the materialized provider.
  const fixture = runtimeFixture({ kind: 'static' }, { createRuntime: async () => ({ provider: providerV4() }) });

  const result = await materializeFixture(fixture);

  expect(result.provider?.model).toBeDefined();
  expect(result.provider?.image).toBeDefined();
  expect(supportsImage(result.provider!.capabilityIndex, 'model')).toBe(false);
});

test('createRuntimeProvider exposes catalog.image ids and does not synthesize language transport when language is empty', async () => {
  const imageCatalog = {
    ...catalog,
    language: [],
    image: [{ id: 'gpt-image-2' }],
  };
  const fixture = runtimeFixture(
    { kind: 'static' },
    {
      catalog: imageCatalog,
      createRuntime: async () => ({
        provider: providerV4(),
        raw: ({ protocol }: { readonly protocol: string }) =>
          protocol === 'openai-image' ? { invoke: async () => new Response('ok') } : undefined,
      }),
    },
  );

  const result = await materializeFixture(fixture);
  const provider = result.provider;

  expect(provider?.models).toContain('gpt-image-2');
  expect(provider?.model).toBeUndefined();
  expect(provider?.image).toBeDefined();
  expect(supportsImage(provider!.capabilityIndex, 'gpt-image-2')).toBe(true);
  expect(provider?.raw?.resolve({ protocol: ProviderProtocol.OpenAIImage, modelId: 'gpt-image-2' })).toBeDefined();
});

test('image-only catalog ids are not embedding-capable when the catalog also has embeddings', async () => {
  const mixedCatalog = {
    ...catalog,
    language: [],
    image: [{ id: 'gpt-image-2' }],
    embedding: [{ id: 'embed' }],
  };
  const fixture = runtimeFixture(
    { kind: 'static' },
    {
      catalog: mixedCatalog,
      createRuntime: async () => ({ provider: providerV4() }),
    },
  );

  const result = await materializeFixture(fixture);
  const provider = result.provider;

  expect(provider?.models).toEqual(expect.arrayContaining(['gpt-image-2', 'embed']));
  expect(supportsImage(provider!.capabilityIndex, 'gpt-image-2')).toBe(true);
  expect(supportsEmbedding(provider!.capabilityIndex, 'gpt-image-2')).toBe(false);
  expect(supportsEmbedding(provider!.capabilityIndex, 'embed')).toBe(true);
});

test('shared language and image catalog ids keep language targetProtocol and image capability', () => {
  const cached = {
    id: 'person',
    kind: ProviderKind.OAuth,
    enabled: true,
    models: ['shared'],
    capabilityIndex: { shared: new Set(['language']) },
    model: {
      invoke: () => {
        throw new Error('unused');
      },
    },
  } as never;

  const next = withRoutingConfig(cached, providerConfig as never, {
    ...catalog,
    language: [{ id: 'shared', displayName: 'Chat', extra: { protocol: 'anthropic' } }],
    image: [{ id: 'shared', displayName: 'Image', extra: { protocol: 'openai-image' } }],
  });

  expect(next.upstreamMetadata?.shared).toEqual({
    name: 'Chat',
    protocol: ProviderProtocol.Anthropic,
  });
  expect(supportsImage(next.capabilityIndex, 'shared')).toBe(true);
  expect(next.capabilityIndex.shared?.has('language')).toBe(true);
});

test('unions catalog language and embedding into models and attaches embedding convert', async () => {
  const fixture = runtimeFixture({ kind: 'static' }, { createRuntime: async () => ({ provider: providerV4() }) });
  fixture.repository.writeCatalog(
    'person',
    {
      ...catalog,
      language: [{ id: 'chat' }, { id: 'shared' }],
      embedding: [{ id: 'embed', displayName: 'Embed Model', extra: { protocol: 'gemini' } }, { id: 'shared' }],
    },
    1_000,
  );

  const first = await materializeFixture(fixture);

  expect(first.provider?.models).toEqual(['chat', 'shared', 'embed']);
  expect(typeof first.provider?.embedding?.embed).toBe('function');
  expect(first.provider?.upstreamMetadata?.embed).toEqual({
    name: 'Embed Model',
    protocol: ProviderProtocol.Gemini,
  });

  const second = await materializePluginProvider({
    config: { ...providerConfig, excludedModels: ['chat', 'shared'] },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    previous: first.cacheEntry,
  });

  expect(second.cacheEntry?.identity).toBe(first.cacheEntry?.identity);
  expect(second.provider?.models).toEqual(['embed']);

  const third = await materializePluginProvider({
    config: providerConfig,
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    previous: second.cacheEntry,
  });

  expect(third.provider?.models).toEqual(['chat', 'shared', 'embed']);
});

test('forwards embedding capability and catalog extra to the plugin raw resolver', async () => {
  const observed: unknown[] = [];
  const fixture = runtimeFixture(
    { kind: 'static' },
    {
      catalog: {
        ...catalog,
        language: [{ id: 'chat' }],
        embedding: [{ id: 'embed', extra: { region: 'us', protocol: 'gemini' } }],
      },
      createRuntime: async () =>
        ({
          provider: providerV4(),
          raw(input: Parameters<RawResolver>[0]) {
            observed.push(input);
            return { invoke: async () => new Response('ok') };
          },
        }) as never,
    },
  );
  fixture.repository.writeCatalog(
    'person',
    {
      ...catalog,
      language: [{ id: 'chat' }],
      embedding: [{ id: 'embed', extra: { region: 'us', protocol: 'gemini' } }],
    },
    1_000,
  );

  const result = await materializeFixture(fixture);
  const transport = result.provider?.raw?.resolve({
    protocol: ProviderProtocol.Gemini,
    modelId: 'embed',
    capability: 'embedding',
  });

  expect(await transport?.invoke(new Request('https://example.test'))).toBeInstanceOf(Response);
  expect(observed[0]).toEqual({
    protocol: 'gemini',
    modelId: 'embed',
    extra: { region: 'us', protocol: 'gemini' },
    capability: 'embedding',
  });
});

test('cached routing still inherits a newly advertised plugin default alias', async () => {
  let suggestions: Record<string, { model: string }> = {};
  const fixture = runtimeFixture(
    { kind: 'static' },
    {
      createRuntime: async () => ({ provider: providerV4() }),
      defaultAliases: () => suggestions,
    },
  );
  fixture.repository.writeCatalog('person', { ...catalog, language: [{ id: 'model' }, { id: 'fresh' }] }, 1_000);

  const first = await materializePluginProvider({
    config: providerConfig,
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  });
  expect(first.provider?.alias).toBeUndefined();

  suggestions = { fresh: { model: 'fresh' } };
  const second = await materializePluginProvider({
    config: providerConfig,
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    previous: first.cacheEntry,
  });

  expect(second.cacheEntry?.identity).toBe(first.cacheEntry?.identity);
  expect(second.provider?.alias).toEqual({ fresh: { model: 'fresh', preserve: false } });
});
