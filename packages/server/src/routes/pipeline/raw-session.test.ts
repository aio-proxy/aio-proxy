import { expect, test } from 'bun:test';

import { openAIResponsesAdapter } from '@aio-proxy/core';
import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';
import { ProviderProtocol } from '@aio-proxy/types';

import {
  defineProviderRouteSource,
  jsonRequest,
  REQUESTED_MODEL,
  rawProvider,
  settleRecording,
} from '../../../__tests__/pipeline-helpers';
import { attributeName, spanName } from '../../request-tracing';
import type { ProviderRouteSource } from '../../runtime';
import { createUsageCapture } from '../../usage-capture';
import { handleProtocolRequest } from './index';

test.each([
  ['JSON', false, JSON.stringify({ id: 'resp_raw_json', status: 'completed' }), 'resp_raw_json'],
  [
    'SSE',
    true,
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_raw_sse","status":"completed"}}\n\n',
    'resp_raw_sse',
  ],
] as const)('commits a completed raw OpenAI Responses %s response', async (_shape, stream, body, responseId) => {
  let logicalRequest: LogicalRequestContext | undefined;
  const provider = rawProvider({
    id: 'raw',
    modelId: REQUESTED_MODEL,
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async (_request, context) => {
      logicalRequest = context;
      return new Response(body, {
        headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' },
      });
    },
  });
  const source = realUsageSource(defineProviderRouteSource([provider]).source);

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: jsonRequest({ input: 'ping', model: REQUESTED_MODEL, stream }),
    source,
  });
  await response.text();
  const resumed = previous(source, responseId);

  // The resumed session mirrors the original logical session's key and source
  // (generated here), matching the persisted path; resolvedBy proves the commit
  // was resolved through previous-response lookup.
  expect(resumed.session).toEqual({ key: logicalRequest?.session.key, source: 'generated' });
  expect(resumed.resolvedBy).toBe('previous-response');
});

test.each([
  ['incomplete JSON', JSON.stringify({ id: 'resp_incomplete', status: 'incomplete' }), 'application/json'],
  [
    'failed SSE',
    'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_failed","status":"failed"}}\n\n',
    'text/event-stream',
  ],
] as const)('does not commit a raw OpenAI Responses %s response', async (_shape, body, contentType) => {
  const responseId = body.includes('resp_incomplete') ? 'resp_incomplete' : 'resp_failed';
  const provider = rawProvider({
    id: 'raw',
    modelId: REQUESTED_MODEL,
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async () => new Response(body, { headers: { 'content-type': contentType } }),
  });
  const route = defineProviderRouteSource([provider]);
  const source = realUsageSource(route.source);

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: jsonRequest({ input: 'ping', model: REQUESTED_MODEL, stream: contentType === 'text/event-stream' }),
    source,
  });
  await response.text();
  await settleRecording(route.recording);

  const notCommitted = previous(source, responseId);
  expect(notCommitted.session.source).toBe('generated');
  expect(notCommitted.resolvedBy).toBe('generated');
  expect(route.recording.finals).toEqual([
    expect.objectContaining({ outcome: 'failure', finalProviderId: 'raw', finalStatusCode: 200 }),
  ]);
});

test('does not commit a completed raw response event when the client cancels before EOF', async () => {
  const encoder = new TextEncoder();
  const provider = rawProvider({
    id: 'raw',
    modelId: REQUESTED_MODEL,
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_cancelled","status":"completed"}}\n\n',
              ),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const source = realUsageSource(defineProviderRouteSource([provider]).source);
  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: jsonRequest({ input: 'ping', model: REQUESTED_MODEL, stream: true }),
    source,
  });
  const reader = response.body?.getReader();

  await reader?.read();
  await reader?.cancel('client stopped');

  const notCommitted = previous(source, 'resp_cancelled');
  expect(notCommitted.session.source).toBe('generated');
  expect(notCommitted.resolvedBy).toBe('generated');
});

test('records the response ID on the trace when the terminal frame precedes EOF', async () => {
  const encoder = new TextEncoder();
  let releaseTail: (() => void) | undefined;
  const tailGate = new Promise<void>((resolve) => (releaseTail = resolve));
  const provider = rawProvider({
    id: 'raw',
    modelId: REQUESTED_MODEL,
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            controller.enqueue(
              encoder.encode(
                'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_terminal","status":"completed"}}\n\n',
              ),
            );
            // Hold the stream open past the terminal frame, then close so the
            // trace settles at the terminal frame — before EOF.
            await tailGate;
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const route = defineProviderRouteSource([provider]);
  const source = realUsageSource(route.source);
  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: jsonRequest({ input: 'ping', model: REQUESTED_MODEL, stream: true }),
    source,
  });
  const reader = response.body!.getReader();
  await reader.read(); // consume the terminal frame; trace resolves here, before EOF
  await settleRecording(route.recording);

  // The finished trace records the upstream response ID even though EOF is still
  // pending — otherwise a restart could not recover provider/session ownership.
  expect(route.recording.finals[0]?.responseId).toBe('resp_terminal');

  releaseTail?.();
  await reader.cancel();
});

test.each([
  ['streaming response without content type', true, undefined, 200, 'text/event-stream; charset=utf-8'],
  ['buffered response without content type', false, undefined, 200, null],
  [
    'streaming response with an existing content type',
    true,
    'application/octet-stream',
    200,
    'application/octet-stream',
  ],
  ['streaming error response without content type', true, undefined, 400, null],
] as const)('normalizes raw response content type for a %s', async (_case, stream, contentType, status, expected) => {
  const body = stream
    ? 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
    : '{"status":"completed"}';
  const provider = rawProvider({
    id: 'raw',
    modelId: REQUESTED_MODEL,
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async () =>
      new Response(
        new TextEncoder().encode(body),
        contentType === undefined ? { status } : { headers: { 'content-type': contentType }, status },
      ),
  });
  const route = defineProviderRouteSource([provider]);
  const source = realUsageSource(route.source);

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: jsonRequest({ input: 'ping', model: REQUESTED_MODEL, stream }),
    source,
  });

  expect(response.headers.get('content-type')).toBe(expected);
  await response.text();
  await settleRecording(route.recording);
  const root = route.recording.spans.find((span) => span.name === spanName.request);
  expect(root?.attributes[attributeName.diagnosticResponseContentType] ?? null).toBe(expected);
  if (stream && contentType === undefined && status === 200) {
    expect(typeof route.recording.attempts[0]?.ttftMs).toBe('number');
  }
});

function realUsageSource(source: ProviderRouteSource): ProviderRouteSource {
  return { ...source, usageCapture: createUsageCapture() };
}

function previous(source: ProviderRouteSource, responseId: string) {
  return source.logicalSessionStore.begin({
    headers: new Headers(),
    hints: { candidates: [], previousResponseId: responseId, transcript: 'different request' },
  });
}
