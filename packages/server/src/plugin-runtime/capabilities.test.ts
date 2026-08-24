import { afterEach, expect, test } from 'bun:test';

import type { LogicalRequestContext, RawResolver, RawTransportOptions } from '@aio-proxy/plugin-sdk';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

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

test('plugin raw capability receives catalog metadata and rejects malformed transports', async () => {
  const modelId = 'model';
  const observed: unknown[] = [];
  const fixture = runtimeFixture(
    { kind: 'static' },
    {
      catalog: {
        ...catalog,
        language: [{ id: 'model', displayName: 'Catalog Name', metadata: { region: 'us', protocol: 'anthropic' } }],
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
        { id: 'model', displayName: 'Catalog Name', metadata: { region: 'us', protocol: 'anthropic' } },
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
      metadata: { model: { name: 'Configured Name', limit: { context: 400_000, input: 272_000 } } },
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
    metadata: { region: 'us', protocol: 'anthropic' },
  });
  expect(result.provider?.configMetadata?.[modelId]).toEqual({
    name: 'Configured Name',
    limit: { context: 400_000, input: 272_000 },
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

  const next = withRoutingConfig(cached, { ...providerConfig, models: ['b'] } as never, ['a', 'b']);

  expect(next.models).toEqual(['b']);
});
