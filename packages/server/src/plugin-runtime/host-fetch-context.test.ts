import { afterEach, expect, test } from 'bun:test';

import { ProviderKind } from '@aio-proxy/types';

import { createObservedFetch, withAttemptLogContext, withRequestLogContext } from '../request-logging';
import { reconstructed, waitFor } from '../request-logging/test-support';
import type { ServerLog } from '../server-log';
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
  let capturedFetch: typeof globalThis.fetch | undefined;
  let capturedModelFetch: typeof globalThis.fetch | undefined;
  const fixture = runtimeFixture(
    { kind: 'static' },
    {
      providerId: 'oauth',
      async createRuntime(context) {
        capturedFetch = context.fetch;
        capturedModelFetch = context.modelFetch;
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

  await materializePluginProvider({
    config: {
      id: 'oauth',
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: '@example/oauth',
      capability: 'default',
    },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    runtimeFetch: baseFetch,
    runtimeModelFetch: createObservedFetch(baseFetch),
  });

  expect(capturedFetch).toBeFunction();
  expect(capturedModelFetch).toBeFunction();

  await withRequestLogContext({ requestId: 'request-1', debug: true, logger: (entry) => logs.push(entry) }, () =>
    withAttemptLogContext({ attemptIndex: 0, providerId: 'oauth', modelId: 'model' }, async () => {
      await capturedFetch?.('https://oauth-upstream.test/token', {
        method: 'POST',
        body: 'refresh-token-secret',
      });
      await capturedModelFetch?.('https://oauth-upstream.test/v1', { method: 'POST', body: 'wire-secret' });
    }),
  );

  await waitFor(() => logs.some(({ event }) => event === 'request.upstream_snapshot'));
  expect(logs).toContainEqual(expect.objectContaining({ event: 'request.upstream_snapshot', providerId: 'oauth' }));
  expect(baseFetchCalls).toHaveLength(2);
  expect(baseFetchBodies).toEqual(['refresh-token-secret', 'wire-secret']);
  expect(reconstructed(logs, 'upstream_request')).toBe('wire-secret');
  expect(JSON.stringify(logs)).not.toContain('refresh-token-secret');
});
