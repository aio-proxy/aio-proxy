import { afterEach, expect, test } from 'bun:test';

import type { RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { type OAuthProvider, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { createProviderRequestTransformFetch } from '../provider-request-transform';
import { createObservedFetch, withAttemptLogContext, withRequestLogContext } from '../request-logging';
import { reconstructed, waitFor } from '../request-logging/test-support';
import type { ServerLog } from '../server-log';
import { createRuntimeFetch } from './runtime-fetch';
import { cleanup, diagnostics, materializePluginProvider, runtimeFixture } from './test-support';

afterEach(cleanup);

test('OAuth runtimes keep control traffic outside observed model fetches', async () => {
  const logs: ServerLog[] = [];
  const baseFetchCalls: Request[] = [];
  const baseFetchBodies: string[] = [];
  const baseFetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    baseFetchCalls.push(request);
    baseFetchBodies.push(await request.text());
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  let capturedFetch: RuntimeFetch | undefined;
  const fixture = runtimeFixture(
    { kind: 'static' },
    {
      providerId: 'oauth',
      async createRuntime(context) {
        capturedFetch = context.fetch;
        return {
          provider: {
            specificationVersion: 'v4',
            languageModel() {
              throw new Error('not called');
            },
            imageModel() {
              throw new Error('not called');
            },
            embeddingModel() {
              throw new Error('not called');
            },
          },
        } as never;
      },
    },
  );
  const config = {
    id: 'oauth',
    kind: ProviderKind.OAuth,
    enabled: true,
    plugin: '@example/oauth',
    capability: 'default',
    transforms: {
      request: [
        {
          update: [
            {
              $set: {
                'request.headers': {
                  $setField: { field: 'x-provider-route', input: '$request.headers', value: 'oauth' },
                },
              },
            },
            { $set: { 'request.body.route': 'oauth' } },
          ],
        },
      ],
    },
  } satisfies OAuthProvider;

  await materializePluginProvider({
    config,
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    runtimeFetch: createRuntimeFetch({
      control: baseFetch,
      model: createProviderRequestTransformFetch(config, createObservedFetch(baseFetch)),
    }),
  });

  expect(capturedFetch).toBeFunction();
  if (capturedFetch === undefined) throw new Error('runtime fetch was not captured');
  const runtimeFetch = capturedFetch;

  const auxiliaryInput = 'https://oauth-upstream.test/token';
  const auxiliaryInit = { method: 'POST', body: 'refresh-token-secret' };
  await withRequestLogContext({ requestId: 'request-1', debug: true, logger: (entry) => logs.push(entry) }, () =>
    withAttemptLogContext(
      {
        attemptIndex: 0,
        providerId: 'oauth',
        modelId: 'model',
        requestedModelId: 'client-model',
        sourceProtocol: ProviderProtocol.OpenAIResponse,
        targetProtocol: ProviderProtocol.OpenAICompatible,
      },
      async () => {
        await runtimeFetch(auxiliaryInput, { ...auxiliaryInit, aioProxy: { traffic: 'control' } });
        await runtimeFetch('https://oauth-upstream.test/v1', {
          method: 'POST',
          body: '{"route":"client"}',
          headers: { 'content-type': 'application/json' },
        });
      },
    ),
  );

  await waitFor(() => logs.some(({ event }) => event === 'request.upstream_snapshot'));
  expect(logs).toContainEqual(expect.objectContaining({ event: 'request.upstream_snapshot', providerId: 'oauth' }));
  expect(baseFetchCalls).toHaveLength(2);
  expect(baseFetchBodies).toEqual(['refresh-token-secret', '{"route":"oauth"}']);
  expect(baseFetchCalls[1]?.headers.get('x-provider-route')).toBe('oauth');
  expect(reconstructed(logs, 'upstream_request')).toBe('{"route":"oauth"}');
  expect(JSON.stringify(logs)).not.toContain('refresh-token-secret');
});
