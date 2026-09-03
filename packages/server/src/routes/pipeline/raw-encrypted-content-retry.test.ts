import { expect, test } from 'bun:test';

import { openAIResponsesAdapter } from '@aio-proxy/core';
import { ProviderProtocol } from '@aio-proxy/types';

import { jsonRequest, REQUESTED_MODEL, rawProvider, settleRecording } from '../../../__tests__/pipeline-helpers';
import { attemptsOf, pipeline } from './test-support';

const created =
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n';
const itemAdded = 'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0}\n\n';
const encryptedError =
  'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","code":"invalid_encrypted_content","message":"x"}}\n\n';
const success =
  created + 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}}\n\n';

function sse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function spawnInput() {
  return [
    {
      type: 'agent_message',
      author: '/root',
      recipient: '/root/review_t1',
      content: [{ type: 'encrypted_content', encrypted_content: 'delegated task' }],
    },
  ];
}

function responsesProvider(invoke: (request: Request) => Promise<Response>) {
  return rawProvider({
    id: 'carpool',
    modelId: REQUESTED_MODEL,
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async (request) => invoke(request),
  });
}

test('replays the same raw candidate and hides the failed stream', async () => {
  let calls = 0;
  const bodies: unknown[] = [];
  const primary = responsesProvider(async (request) => {
    calls += 1;
    bodies.push(await request.clone().json());
    return calls === 1 ? sse(created + itemAdded + encryptedError) : sse(success);
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true, input: spawnInput() }));
  const text = await response.text();

  expect(response.status).toBe(200);
  expect(text).toBe(success);
  expect(text).not.toContain('invalid_encrypted_content');
  expect(text).not.toContain('output_item.added');
  expect(calls).toBe(2);
  expect(bodies[1]).toMatchObject({
    input: [{ type: 'agent_message', content: [{ type: 'input_text', text: 'delegated task' }] }],
  });
  await settleRecording(harness.recording);
  expect(attemptsOf(harness.recording)).toEqual([{ outcome: 'success', providerId: 'carpool', statusCode: 200 }]);
});

// A streaming relay may omit Content-Type entirely. raw.ts only infers the SSE
// header after the retry resolver, so without assumeEventStream the error frame
// would reach the client unretried.
test('retries a streamed SSE body that omits its content type', async () => {
  let calls = 0;
  const primary = responsesProvider(async () => {
    calls += 1;
    return calls === 1
      ? new Response(created + encryptedError, { status: 200 })
      : new Response(success, { status: 200 });
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true, input: spawnInput() }));
  const text = await response.text();

  expect(calls).toBe(2);
  expect(text).toBe(success);
  expect(text).not.toContain('invalid_encrypted_content');
});

// Exercises the function_call_output rewrite branch through the real parse step,
// not just the direct helper: that part only survives ingress after Task 1's
// toolOutputContentPartSchema change.
test('rewrites an encrypted function call output through the pipeline', async () => {
  let calls = 0;
  const bodies: unknown[] = [];
  const primary = responsesProvider(async (request) => {
    calls += 1;
    bodies.push(await request.clone().json());
    return calls === 1 ? sse(created + encryptedError) : sse(success);
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  const response = await harness.run(
    jsonRequest({
      model: REQUESTED_MODEL,
      stream: true,
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: [{ type: 'encrypted_content', encrypted_content: 'tool result' }],
        },
      ],
    }),
  );

  expect(response.status).toBe(200);
  expect(calls).toBe(2);
  expect(bodies[1]).toMatchObject({
    input: [{ type: 'function_call_output', output: [{ type: 'input_text', text: 'tool result' }] }],
  });
});

test('does not retry after a content delta', async () => {
  let calls = 0;
  const primary = responsesProvider(async () => {
    calls += 1;
    return sse(
      created +
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}}\n\n' +
        encryptedError,
    );
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  const text = await (
    await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true, input: spawnInput() }))
  ).text();

  expect(calls).toBe(1);
  expect(text).toContain('invalid_encrypted_content');
});

test('retries HTTP 400 invalid_encrypted_content on the same candidate', async () => {
  let calls = 0;
  const primary = responsesProvider(async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json(
        { error: { type: 'invalid_request_error', code: 'invalid_encrypted_content', message: 'x' } },
        { status: 400 },
      );
    }
    return Response.json({ id: 'resp_ok', status: 'completed', output: [] });
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, input: spawnInput() }));

  expect(response.status).toBe(200);
  expect(calls).toBe(2);
  expect(await response.json()).toMatchObject({ id: 'resp_ok' });
});

test('streams a non-JSON 400 without interception', async () => {
  let calls = 0;
  const primary = responsesProvider(async () => {
    calls += 1;
    return new Response('<html>gateway error</html>', {
      status: 400,
      headers: { 'content-type': 'text/html' },
    });
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, input: spawnInput() }));

  expect(response.status).toBe(400);
  expect(calls).toBe(1);
  expect(await response.text()).toContain('gateway error');
});

// Cancellation happens before the second invoke, so a slow or throwing replay
// cannot leave the failed SSE connection open and buffering.
test('cancels the failed stream before invoking the replay', async () => {
  let cancelledBeforeReplay: boolean | undefined;
  let cancelled = false;
  let calls = 0;
  const primary = responsesProvider(async () => {
    calls += 1;
    if (calls === 1) {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(created + encryptedError));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    cancelledBeforeReplay = cancelled;
    throw new Error('replay transport failed');
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true, input: spawnInput() })).catch(() => undefined);

  expect(calls).toBe(2);
  expect(cancelledBeforeReplay).toBe(true);
});

test('commits the upstream error when no rewrite is possible', async () => {
  let calls = 0;
  const primary = responsesProvider(async () => {
    calls += 1;
    return sse(created + encryptedError);
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  const text = await (await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true, input: 'hello' }))).text();

  expect(calls).toBe(1);
  expect(text).toContain('invalid_encrypted_content');
});

test('cancels the replay when the client disconnects', async () => {
  const controller = new AbortController();
  let replaySignal: AbortSignal | undefined;
  let calls = 0;
  const primary = responsesProvider(async (request) => {
    calls += 1;
    if (calls === 1) return sse(created + encryptedError);
    replaySignal = request.signal;
    controller.abort();
    return sse(success);
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  await harness
    .run(jsonRequest({ model: REQUESTED_MODEL, stream: true, input: spawnInput() }, { signal: controller.signal }))
    .catch(() => undefined);

  expect(calls).toBe(2);
  expect(replaySignal?.aborted).toBe(true);
});
