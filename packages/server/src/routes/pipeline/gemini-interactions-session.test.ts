import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { geminiInteractionsAdapter } from '@aio-proxy/core';
import { createTraceStore, openDb } from '@aio-proxy/core/db';
import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';
import { ProviderProtocol } from '@aio-proxy/types';

import { handleProtocolRequest } from '.';
import {
  defineProviderRouteSource,
  jsonRequest,
  rawProvider,
  REQUESTED_MODEL,
  settleRecording,
} from '../../../__tests__/pipeline-helpers';
import { LogicalSessionStore } from '../../logical-session-store';
import { createRequestTraceRecorder } from '../../request-tracing';
import { createUsageCapture } from '../../usage-capture';

test.each(['completed', 'requires_action', 'incomplete'] as const)(
  'reuses a %s native Gemini Interaction through the full raw pipeline',
  async (status) => {
    const contexts: LogicalRequestContext[] = [];
    let responseIndex = 0;
    const provider = rawProvider({
      id: 'gemini-interactions',
      modelId: REQUESTED_MODEL,
      protocol: ProviderProtocol.GeminiInteractions,
      invoke: async (_request, context) => {
        contexts.push(context);
        responseIndex += 1;
        return Response.json({ id: `intr_${responseIndex}`, status });
      },
    });
    const route = defineProviderRouteSource([provider]);
    const source = { ...route.source, usageCapture: createUsageCapture() };

    const first = await handleProtocolRequest({
      adapter: geminiInteractionsAdapter,
      context: {},
      rawRequest: jsonRequest({ model: REQUESTED_MODEL, input: 'first' }),
      source,
    });
    expect(await first.json()).toEqual({ id: 'intr_1', status });
    await settleRecording(route.recording);

    const second = await handleProtocolRequest({
      adapter: geminiInteractionsAdapter,
      context: {},
      rawRequest: jsonRequest({
        model: REQUESTED_MODEL,
        input: 'second',
        previous_interaction_id: 'intr_1',
      }),
      source,
    });
    expect(await second.json()).toEqual({ id: 'intr_2', status });
    await settleRecording(route.recording);

    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.session.source).toBe('generated');
    expect(contexts[1]?.session).toEqual(contexts[0]?.session);
    expect(route.recording.finals.map((final) => final.responseId)).toEqual(['intr_1', 'intr_2']);
  },
);

test('does not persist a completed native Gemini Interaction cancelled before EOF', async () => {
  const home = mkdtempSync(`${tmpdir()}/aio-proxy-gemini-interaction-owner-`);
  const handle = openDb({ home });
  try {
    const traceStore = createTraceStore(handle.db);
    const recorded = Promise.withResolvers<void>();
    const logicalSessionStore = new LogicalSessionStore({ repository: traceStore });
    const requestRecorder = createRequestTraceRecorder({
      store: {
        complete(completion) {
          const persisted = traceStore.complete(completion);
          recorded.resolve();
          return persisted;
        },
        prune: traceStore.prune,
        recover: traceStore.recover,
        startRoot: traceStore.startRoot,
      },
      onResponsePersisted: (responseId) => logicalSessionStore.reconcilePersistedResponse(responseId),
    });
    const provider = rawProvider({
      id: 'gemini-interactions',
      modelId: REQUESTED_MODEL,
      protocol: ProviderProtocol.GeminiInteractions,
      invoke: async () =>
        new Response(completedInteractionStream(), { headers: { 'content-type': 'text/event-stream' } }),
    });
    const route = defineProviderRouteSource([provider]);
    const source = { ...route.source, logicalSessionStore, requestRecorder, usageCapture: createUsageCapture() };
    const response = await handleProtocolRequest({
      adapter: geminiInteractionsAdapter,
      context: {},
      rawRequest: jsonRequest({ model: REQUESTED_MODEL, input: 'first', stream: true }),
      source,
    });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('expected response body');
    expect((await reader.read()).done).toBe(false);
    await reader.cancel('client stopped before EOF');
    await recorded.promise;

    expect(responseStatus(logicalSessionStore, 'intr_cancelled')).toBe('none');

    handle.close();
    const reopened = openDb({ home });
    try {
      const reopenedStore = new LogicalSessionStore({ repository: createTraceStore(reopened.db) });
      expect(responseStatus(reopenedStore, 'intr_cancelled')).toBe('none');
    } finally {
      reopened.close();
    }
  } finally {
    handle.close();
    rmSync(home, { force: true, recursive: true });
  }
});

function completedInteractionStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"id":"intr_cancelled","status":"completed"}}\n\n',
        ),
      );
    },
  });
}

function responseStatus(store: LogicalSessionStore, previousResponseId: string): string {
  return store.begin({
    requestId: 'next-request',
    requestedModelId: REQUESTED_MODEL,
    hints: { candidates: [], previousResponseId, transcript: {} },
    headers: new Headers(),
  }).responseStatus;
}
