import { expect, test } from 'bun:test';

import type { AiSdkProviderInstance, ApiProviderInstance, ProviderFetch } from '@aio-proxy/core';
import { ConfigSchema, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { withAttemptLogContext, withRequestLogContext } from '../request-logging';
import { reconstructed, waitFor } from '../request-logging/test-support';
import { createAttemptResponseObservation, withAttemptResponseObservation } from '../response-observation';
import type { ServerLog } from '../server-log';
import { materializeProviders } from './materialize';

function observedFetchFixture() {
  const config = ConfigSchema.parse({
    proxy: 'http://global.proxy.test:8080',
    providers: {
      api: {
        baseURL: 'https://api.provider.test',
        kind: ProviderKind.Api,
        models: ['api-model'],
        protocol: ProviderProtocol.OpenAICompatible,
      },
      sdk: {
        kind: ProviderKind.AiSdk,
        models: ['sdk-model'],
        packageName: '@ai-sdk/openai-compatible',
        proxy: 'http://sdk.proxy.test:9090',
      },
    },
  });
  const logs: ServerLog[] = [];
  const proxies: (string | undefined)[] = [];
  const delegated: { readonly body: string; readonly proxy: string | undefined; readonly url: string }[] = [];
  let apiFetch: ProviderFetch | undefined;
  let bridgeFetch: ProviderFetch | undefined;
  let aiSdkFetch: ProviderFetch | undefined;

  const runtime = materializeProviders(config, {
    createProxyFetch(proxy) {
      proxies.push(proxy);
      return (async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        delegated.push({ body: await request.text(), proxy, url: request.url });
        return new Response(null, { status: 204 });
      }) as ProviderFetch;
    },
    createApiProvider(provider, options) {
      apiFetch = options.fetch;
      return {
        ...provider,
        passthrough: (request) => apiFetch!(request),
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
      aiSdkFetch = options.fetch;
      return {
        enabled: true,
        ensureAvailable: async () => {
          await aiSdkFetch!('https://sdk.provider.test/probe');
        },
        id: provider.id,
        invoke: () => new ReadableStream(),
        kind: ProviderKind.AiSdk,
      } satisfies AiSdkProviderInstance;
    },
  });

  return {
    delegated,
    logs,
    proxies,
    runtime,
    apiFetch: () => apiFetch,
    bridgeFetch: () => bridgeFetch,
    aiSdkFetch: () => aiSdkFetch,
  };
}

test('materialized provider fetches observe final upstream requests only inside debug attempts', async () => {
  const fixture = observedFetchFixture();
  const { delegated, logs, proxies, runtime } = fixture;
  const apiFetch = fixture.apiFetch();
  const aiSdkFetch = fixture.aiSdkFetch();

  expect(proxies).toEqual(['http://global.proxy.test:8080', 'http://sdk.proxy.test:9090']);
  expect(apiFetch).toBe(fixture.bridgeFetch());

  expect(await Promise.all([...runtime.probes.values()].map((probe) => probe()))).toEqual(['OK', 'OK']);
  expect(delegated).toHaveLength(2);
  expect(logs).toEqual([]);

  await withRequestLogContext(
    { requestId: 'request-1', debug: true, logger: (entry) => logs.push(entry) },
    async () => {
      await withAttemptLogContext({ attemptIndex: 0, providerId: 'api', modelId: 'api-model' }, () =>
        apiFetch!('https://final-api.test/v1/responses?api_key=api-query-secret', {
          body: JSON.stringify({ apiKey: 'api-body-secret', model: 'api-model', prompt: 'api-prompt-secret' }),
          headers: {
            'content-type': 'application/json',
            'user-agent': 'api-generated-agent',
            'x-api-key': 'api-header-secret',
          },
          method: 'POST',
        }),
      );
      await withAttemptLogContext({ attemptIndex: 1, providerId: 'sdk', modelId: 'sdk-model' }, () =>
        aiSdkFetch!('https://final-sdk.test/v1/chat/completions?token=sdk-query-secret', {
          body: JSON.stringify({ messages: [{ content: 'sdk-content-secret', role: 'user' }], model: 'sdk-model' }),
          headers: {
            accept: 'application/json',
            authorization: 'Bearer sdk-header-secret',
            'content-type': 'application/json',
          },
          method: 'POST',
        }),
      );
    },
  );

  await waitFor(() => logs.filter((entry) => entry.event === 'request.upstream_snapshot').length === 2);
  const snapshots = logs
    .filter((entry) => entry.event === 'request.upstream_snapshot')
    .sort((left, right) => left.attemptIndex - right.attemptIndex);
  expect(snapshots).toHaveLength(2);
  expect(snapshots).toEqual([
    expect.objectContaining({
      attemptIndex: 0,
      providerId: 'api',
      modelId: 'api-model',
      method: 'POST',
      url: 'https://final-api.test/v1/responses?api_key=api-query-secret',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'api-generated-agent',
        'x-api-key': '[REDACTED]',
      },
    }),
    expect.objectContaining({
      attemptIndex: 1,
      providerId: 'sdk',
      modelId: 'sdk-model',
      method: 'POST',
      url: 'https://final-sdk.test/v1/chat/completions?token=sdk-query-secret',
      headers: {
        accept: 'application/json',
        authorization: '[REDACTED]',
        'content-type': 'application/json',
      },
    }),
  ]);
  expect(reconstructed(logs, 'upstream_request', 0)).toContain('api-body-secret');
  expect(reconstructed(logs, 'upstream_request', 0)).toContain('api-prompt-secret');
  expect(reconstructed(logs, 'upstream_request', 1)).toContain('sdk-content-secret');
  expect(JSON.stringify(logs)).not.toContain('api-header-secret');
  expect(JSON.stringify(logs)).not.toContain('sdk-header-secret');
  expect(delegated).toHaveLength(4);
  expect(delegated.slice(-2).map(({ body }) => body)).toEqual([
    reconstructed(logs, 'upstream_request', 0),
    reconstructed(logs, 'upstream_request', 1),
  ]);
});

test('materialized provider fetches record transport headers without debug logging', async () => {
  const fixture = observedFetchFixture();
  const apiFetch = fixture.apiFetch();
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 10 });

  const response = await withAttemptResponseObservation(observation, () =>
    apiFetch!('https://final-api.test/v1/models'),
  );

  expect(response.status).toBe(204);
  expect(observation.snapshot()).toEqual({ transportObservation: 'body', upstreamHeadersMs: 10 });
  expect(fixture.logs).toEqual([]);
});
