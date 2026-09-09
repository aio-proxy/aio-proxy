import { expect, mock, test } from 'bun:test';

import { openAIVideosAdapter } from '@aio-proxy/core';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { defineProviderRouteSource, type FakeProvider, settleRecording } from '../../../../__tests__/pipeline-helpers';
import type { RuntimeProviderInstance } from '../../../runtime';
import { handleProtocolRequest } from '../index';

test('a raw-less video convert rejection records unsupported_feature', async () => {
  const modelInvoke = mock(() => new ReadableStream());
  const provider = {
    id: 'sdk',
    kind: ProviderKind.AiSdk,
    enabled: true,
    models: ['sora-2'],
    capabilityIndex: { 'sora-2': new Set(['video'] as const) },
    model: { invoke: modelInvoke },
  } as unknown as RuntimeProviderInstance;
  const route = defineProviderRouteSource([{ calls: { ensure: 0, model: [], raw: [] }, provider }]);

  const response = await handleProtocolRequest({
    adapter: openAIVideosAdapter,
    context: { operation: 'create' },
    rawRequest: new Request('https://proxy.test/v1/videos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat' }),
    }),
    source: route.source,
  });

  expect(response.status).toBe(501);
  expect(await response.json()).toMatchObject({
    error: { code: 'unsupported_feature', message: 'OpenAI Videos feature is not supported: video_convert' },
  });
  expect(modelInvoke).not.toHaveBeenCalled();
  await settleRecording(route.recording);
  expect(route.recording.attempts).toEqual([
    expect.objectContaining({
      errorCode: 'unsupported_feature',
      outcome: 'failure',
      providerId: 'sdk',
      statusCode: 501,
    }),
  ]);
  expect(route.recording.finals[0]).toEqual(
    expect.objectContaining({ errorCode: 'unsupported_feature', outcome: 'failure' }),
  );
});

test('a streamed no-rewrite create 503 falls back without hanging on invoked cancel', async () => {
  const first = videoRawProvider('down', () => Response.json({ error: { code: 'overloaded' } }, { status: 503 }));
  const second = videoRawProvider('up', () => Response.json({ id: 'video_ok', object: 'video', status: 'queued' }));
  const route = defineProviderRouteSource([first, second]);

  const outcome = await Promise.race([
    handleProtocolRequest({
      adapter: openAIVideosAdapter,
      context: { operation: 'create' },
      rawRequest: streamedVideoCreate(),
      source: route.source,
    }),
    Bun.sleep(1000).then(() => 'timed-out' as const),
  ]);

  expect(outcome).not.toBe('timed-out');
  expect((outcome as Response).status).toBe(200);
  expect(first.calls.raw).toHaveLength(1);
  expect(second.calls.raw).toHaveLength(1);
});

function streamedVideoCreate(): Request {
  return new Request('https://proxy.test/v1/videos', {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ model: 'sora-2', prompt: 'a cat' })));
        controller.close();
      },
    }),
    duplex: 'half',
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

function videoRawProvider(id: string, invoke: (request: Request) => Response): FakeProvider {
  const calls = { ensure: 0, model: [] as never[], raw: [] as Request[] };
  return {
    calls,
    provider: {
      capabilityIndex: { 'sora-2': new Set(['video'] as const) },
      enabled: true,
      id,
      kind: ProviderKind.Api,
      models: ['sora-2'],
      raw: {
        resolve: ({ protocol }) =>
          protocol === ProviderProtocol.OpenAIVideo
            ? {
                invoke: async (request) => {
                  calls.raw.push(request);
                  return invoke(request);
                },
              }
            : undefined,
      },
    } as RuntimeProviderInstance,
  };
}
