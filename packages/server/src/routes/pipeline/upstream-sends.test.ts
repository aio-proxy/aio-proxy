import { expect, test } from 'bun:test';

import { createAnthropic } from '@ai-sdk/anthropic';
import { openAIResponsesAdapter } from '@aio-proxy/core';
import { ProviderProtocol } from '@aio-proxy/types';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { streamText } from 'ai';
import { z } from 'zod';

import {
  jsonRequest,
  modelProvider,
  rawProvider,
  REQUESTED_MODEL,
  settleRecording,
} from '../../../__tests__/pipeline-helpers';
import { createObservedFetch } from '../../request-logging';
import { attributeName } from '../../request-tracing';
import { createUsageCapture } from '../../usage-capture';
import { pipeline } from './test-support';

test.each(['json', 'sse'] as const)(
  'raw %s protocol rewrite records both sends and the selected response',
  async (mode) => {
    let calls = 0;
    const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const success =
      event('response.output_text.delta', { delta: 'ok' }) +
      event('response.completed', { response: { id: 'resp_ok', status: 'completed', output: [] } });
    const fetcher = createObservedFetch(async () => {
      if (calls++ === 0) {
        const error = { type: 'invalid_request_error', code: 'invalid_encrypted_content', message: 'cannot decrypt' };
        return mode === 'json'
          ? Response.json({ error }, { status: 400 })
          : new Response(event('error', { error }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return mode === 'json'
        ? Response.json({ id: 'resp_ok', status: 'completed', output: [] })
        : new Response(success, { headers: { 'content-type': 'text/event-stream' } });
    });
    const harness = pipeline(
      [
        rawProvider({
          id: 'raw',
          modelId: REQUESTED_MODEL,
          protocol: ProviderProtocol.OpenAIResponse,
          invoke: (request) => fetcher(new Request('https://upstream.test/responses', request), { decompress: false }),
        }),
      ],
      { adapter: openAIResponsesAdapter },
    );
    harness.source.usageCapture.passthrough = createUsageCapture().passthrough;
    const response = await harness.run(
      jsonRequest({
        model: REQUESTED_MODEL,
        stream: mode === 'sse',
        input: [
          {
            type: 'agent_message',
            author: '/root',
            recipient: '/root/reviewer',
            content: [{ type: 'encrypted_content', encrypted_content: 'retry me' }],
          },
        ],
      }),
    );
    expect(await response.text()).toContain('resp_ok');
    await settleRecording(harness.recording);
    const spans = harness.recording.spans;
    const attempt = spans.find(
      (span) =>
        span.attributes[attributeName.attemptIndex] === 0 &&
        span.attributes['aio_proxy.upstream.send_index'] === undefined,
    );
    const sends = spans.filter((span) => span.attributes['aio_proxy.upstream.send_index'] !== undefined);
    expect(calls).toBe(2);
    expect(sends).toHaveLength(2);
    expect(attempt?.attributes).toMatchObject({
      'aio_proxy.attempt.http_sends': 2,
      'aio_proxy.attempt.response_send_index': 1,
    });
    for (const send of sends) {
      expect(send.kind).toBe(SpanKind.CLIENT);
      expect(send.parentSpanId).toBe(attempt?.spanId);
      expect(send.attributes['aio_proxy.upstream.headers_ms']).toEqual(expect.any(Number));
      expect(send.attributes['aio_proxy.upstream.first_byte_ms']).toEqual(expect.any(Number));
    }
    expect(sends[0]?.statusCode).toBe(SpanStatusCode.ERROR);
    expect(sends[0]?.attributes).toMatchObject({ 'aio_proxy.upstream.retry_reason': 'protocol_rewrite' });
    expect(sends[1]?.attributes).toMatchObject({ 'aio_proxy.upstream.response_selected': true });
    if (mode === 'sse') {
      for (const send of sends)
        expect(send.attributes['aio_proxy.upstream.first_sse_event_ms']).toEqual(expect.any(Number));
    }
  },
);

test.each(['text', 'tool'] as const)(
  'AI SDK automatic retries identify a %s response inside one candidate',
  async (mode) => {
    let calls = 0;
    const fetcher = createObservedFetch(async () => {
      if (calls++ === 0)
        return Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'retry' } }, { status: 503 });
      const events = [
        {
          type: 'message_start',
          message: {
            id: 'msg_ok',
            type: 'message',
            role: 'assistant',
            model: 'claude-test',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block:
            mode === 'text'
              ? { type: 'text', text: '' }
              : { type: 'tool_use', id: 'call_weather', name: 'weather', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta:
            mode === 'text'
              ? { type: 'text_delta', text: 'sdk retry ok' }
              : { type: 'input_json_delta', partial_json: '{"city":"Singapore"}' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: mode === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null },
          usage: { output_tokens: 3 },
        },
        { type: 'message_stop' },
      ];
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const anthropic = createAnthropic({ apiKey: 'test', fetch: fetcher });
    const harness = pipeline(
      [
        modelProvider({
          id: 'sdk',
          invoke: (input) =>
            streamText({
              model: anthropic('claude-test'),
              messages: input.messages,
              maxRetries: 1,
              maxOutputTokens: 100,
              tools: { weather: { inputSchema: z.object({ city: z.string() }) } },
            }).fullStream,
        }),
      ],
      { adapter: openAIResponsesAdapter },
    );
    const response = await harness.run(
      jsonRequest({ model: REQUESTED_MODEL, stream: true, input: [{ role: 'user', content: 'weather' }] }),
    );
    expect(await response.text()).toContain(mode === 'text' ? 'sdk retry ok' : 'weather');
    await settleRecording(harness.recording);
    const attempt = harness.recording.spans.find(
      (span) =>
        span.attributes[attributeName.attemptIndex] === 0 &&
        span.attributes['aio_proxy.upstream.send_index'] === undefined,
    );
    const sends = harness.recording.spans.filter(
      (span) => span.attributes['aio_proxy.upstream.send_index'] !== undefined,
    );
    expect(calls).toBe(2);
    expect(sends).toHaveLength(2);
    expect(sends.map((span) => span.attributes['http.response.status_code'])).toEqual([503, 200]);
    expect(sends.every((span) => span.parentSpanId === attempt?.spanId)).toBe(true);
    expect(sends.every((span) => typeof span.attributes['aio_proxy.upstream.headers_ms'] === 'number')).toBe(true);
    expect(attempt?.attributes['aio_proxy.attempt.response_send_index']).toBe(1);
    if (mode === 'tool') expect(attempt?.attributes[attributeName.genAiTimeToFirstChunk]).toBeUndefined();
  },
);

test('raw fallback records cancellation before the failed candidate span settles', async () => {
  let cancelled = false;
  const fetcher = createObservedFetch(async (input) =>
    String(input).endsWith('/first')
      ? new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 503 },
        )
      : Response.json({ choices: [{ message: { role: 'assistant', content: 'fallback ok' } }] }),
  );
  const harness = pipeline([
    rawProvider({
      id: 'first',
      priority: 1,
      invoke: () => fetcher('https://upstream.test/first', { decompress: false }),
    }),
    rawProvider({ id: 'second', invoke: () => fetcher('https://upstream.test/second', { decompress: false }) }),
  ]);
  harness.source.usageCapture.passthrough = createUsageCapture().passthrough;
  expect(await (await harness.run(jsonRequest({ model: REQUESTED_MODEL }))).text()).toContain('fallback ok');
  await settleRecording(harness.recording);
  expect(cancelled).toBe(true);
  const sends = harness.recording.spans.filter(
    (span) => span.attributes['aio_proxy.upstream.send_index'] !== undefined,
  );
  expect(sends).toHaveLength(2);
  expect(sends[0]?.attributes).toMatchObject({
    'aio_proxy.upstream.candidate_index': 0,
    'aio_proxy.upstream.send_index': 0,
    'aio_proxy.upstream.body_outcome': 'cancelled',
    'http.response.status_code': 503,
  });
  expect(sends[1]?.attributes).toMatchObject({
    'aio_proxy.upstream.candidate_index': 1,
    'aio_proxy.upstream.send_index': 0,
  });
});
