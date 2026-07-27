import { describe, expect, test } from 'bun:test';

import { type ModelEventStream, openAIResponsesAdapter } from '@aio-proxy/core';

import {
  defineProviderRouteSource,
  jsonRequest,
  modelProvider,
  REQUESTED_MODEL,
  settleRecording,
  textStream,
} from '../../../__tests__/pipeline-helpers';
import { handleProtocolRequest } from './index';

describe('shared protocol routing pipeline late stream cancellation', () => {
  test('drops an OpenAI response ID cancelled before response.completed is delivered', async () => {
    const controller = new AbortController();
    const upstreamEnded = Promise.withResolvers<void>();
    const responseIdObserved = Promise.withResolvers<string>();
    const provider = modelProvider({
      id: 'provider',
      invoke: () => observedTextStream('done', upstreamEnded.resolve),
    });
    const route = defineProviderRouteSource([provider]);
    const adapter: typeof openAIResponsesAdapter = {
      ...openAIResponsesAdapter,
      modelSse(stream, context) {
        return openAIResponsesAdapter.modelSse(stream, {
          ...context,
          onResponseId(responseId) {
            context.onResponseId?.(responseId);
            responseIdObserved.resolve(responseId);
          },
        });
      },
    };
    const response = await handleProtocolRequest({
      adapter,
      context: {},
      rawRequest: jsonRequest({ model: REQUESTED_MODEL, input: 'ping', stream: true }, { signal: controller.signal }),
      source: route.source,
    });

    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('expected response body');
    expect((await reader.read()).done).toBe(false);
    expect((await reader.read()).done).toBe(false);
    expect((await reader.read()).done).toBe(false);
    const responseId = await responseIdObserved.promise;
    await upstreamEnded.promise;
    await waitForUnlock(route.usage.capturedStreams[0]);
    expect(route.usage.capturedStreams[0]?.locked).toBe(false);

    controller.abort();
    await expect(reader.cancel('client stopped before response.completed')).resolves.toBeUndefined();
    await settleRecording(route.recording);

    expect(route.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: 'provider', outcome: 'cancelled' }),
    );
    const resumed = route.source.logicalSessionStore.begin({
      requestId: 'next-request',
      requestedModelId: REQUESTED_MODEL,
      hints: { candidates: [], previousResponseId: responseId, transcript: {} },
      headers: new Headers(),
    });
    expect(resumed.responseStatus).toBe('none');
  });
});

function observedTextStream(text: string, onEnd: () => void): ModelEventStream {
  const upstreamReader = textStream(text).getReader();
  return new ReadableStream({
    async pull(output) {
      const next = await upstreamReader.read();
      if (next.done) {
        upstreamReader.releaseLock();
        output.close();
        onEnd();
        return;
      }
      output.enqueue(next.value);
    },
    async cancel(reason) {
      try {
        await upstreamReader.cancel(reason);
      } finally {
        upstreamReader.releaseLock();
      }
    },
  });
}

async function waitForUnlock(stream: ReadableStream<unknown> | undefined): Promise<void> {
  for (let attempt = 0; stream?.locked === true && attempt < 10; attempt += 1) await Promise.resolve();
}
