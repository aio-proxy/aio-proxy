import { afterEach, expect, test } from 'bun:test';

import type { LogicalRequestContext, RawResolver, RawTransportOptions } from '@aio-proxy/plugin-sdk';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { supportsEmbedding, supportsImage } from '../provider-runtime/capability-index';
import { exposedModelIds, withRoutingConfig } from './capabilities';
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

test('exposedModelIds: absent or empty whitelist exposes the whole catalog', () => {
  expect(exposedModelIds(['a', 'b'], undefined)).toEqual(['a', 'b']);
  expect(exposedModelIds(['a', 'b'], [])).toEqual(['a', 'b']);
});

test('exposedModelIds: a whitelist intersects the catalog and drops stale entries', () => {
  expect(exposedModelIds(['a', 'b', 'c'], ['b', 'gone', 'a'])).toEqual(['a', 'b']);
});

test('a whitelist filters the freshly materialized catalog', async () => {
  const fixture = runtimeFixture({ kind: 'static' }, { createRuntime: async () => ({ provider: providerV4() }) });
  fixture.repository.writeCatalog('person', { ...catalog, language: [{ id: 'model' }, { id: 'other' }] }, 1_000);

  const result = await materializePluginProvider({
    config: { ...providerConfig, models: ['model'] },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  });

  expect(result.provider?.models).toEqual(['model']); // 'other' is discovered but not exposed
  expect(Object.keys(result.provider?.upstreamMetadata ?? {})).toEqual(['model']);
  expect(result.summary.clientModels).not.toContain('other');
});

test('changing only the whitelist keeps runtime identity stable and takes the cached routing path', async () => {
  const fixture = runtimeFixture({ kind: 'static' }, { createRuntime: async () => ({ provider: providerV4() }) });
  fixture.repository.writeCatalog('person', { ...catalog, language: [{ id: 'model' }, { id: 'other' }] }, 1_000);

  const first = await materializeFixture(fixture);
  expect(first.provider?.models).toEqual(['model', 'other']);

  const second = await materializePluginProvider({
    config: { ...providerConfig, models: ['model'] },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    previous: first.cacheEntry,
  });

  // Same identity -> the provider instance is rebuilt via withRoutingConfig, not re-created:
  expect(second.cacheEntry?.identity).toBe(first.cacheEntry?.identity);
  expect(second.provider?.models).toEqual(['model']);

  // Widening is not a one-way ratchet. Kills the mutant that sources the cached routing path's catalog
  // ids from the already-filtered `previous.provider.models` instead of the discovered catalog: narrowing
  // would then be irreversible, because each cached materialization re-filters a filtered list. That is
  // the exposure defect this branch already shipped once (899d22df).
  const third = await materializePluginProvider({
    config: providerConfig, // whitelist removed again
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

  const next = withRoutingConfig(cached, { ...providerConfig, models: ['b'] } as never, {
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

test('withRoutingConfig does not restore whitelist-excluded catalog ids through upstreamMetadata', () => {
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

  const next = withRoutingConfig(cached, { ...providerConfig, models: ['gpt-5'] } as never, {
    ...catalog,
    language: [{ id: 'gpt-5' }, { id: 'other' }],
    image: [{ id: 'gpt-image-2' }],
  });

  expect(next.models).toEqual(['gpt-5']);
  expect(Object.keys(next.upstreamMetadata ?? {})).toEqual(['gpt-5']);
  expect(supportsImage(next.capabilityIndex, 'gpt-image-2')).toBe(true);
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
    config: { ...providerConfig, models: ['embed'] },
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
