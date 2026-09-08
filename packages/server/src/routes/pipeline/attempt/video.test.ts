import { expect, mock, test } from 'bun:test';

import { openAIVideosAdapter } from '@aio-proxy/core';
import { ProviderKind } from '@aio-proxy/types';

import { defineProviderRouteSource, settleRecording } from '../../../../__tests__/pipeline-helpers';
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
