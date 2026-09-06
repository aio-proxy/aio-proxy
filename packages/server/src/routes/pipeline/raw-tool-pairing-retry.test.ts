import { expect, test } from 'bun:test';

import { openAIResponsesAdapter } from '@aio-proxy/core';
import { ProviderProtocol } from '@aio-proxy/types';

import { jsonRequest, REQUESTED_MODEL, rawProvider, settleRecording } from '../../../__tests__/pipeline-helpers';
import { attemptsOf, pipeline } from './test-support';

// Reproduces the shape that 400s in real Codex traffic: a legitimate transcript
// whose tail call was never answered, sent to a same-protocol provider. Raw
// passthrough wins the dispatch there, so the model path's narration never runs
// and 400 is terminal (shouldFallbackStatus excludes it).
function unansweredCallInput() {
  return [
    { type: 'message', role: 'user', content: 'list the files' },
    { type: 'function_call', call_id: 'call_1', name: 'list_dir', arguments: '{"path":"."}' },
  ];
}

function pairingError(message: string): Response {
  return Response.json({ error: { type: 'invalid_request_error', code: null, message } }, { status: 400 });
}

function responsesProvider(invoke: (request: Request) => Promise<Response>) {
  return rawProvider({
    id: 'carpool',
    modelId: REQUESTED_MODEL,
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async (request) => invoke(request),
  });
}

test('replays a tool-pairing 400 with the unanswered call narrated as text', async () => {
  let calls = 0;
  const bodies: unknown[] = [];
  const primary = responsesProvider(async (request) => {
    calls += 1;
    bodies.push(await request.clone().json());
    if (calls === 1) return pairingError('No tool output found for function call call_1.');
    return Response.json({ id: 'resp_ok', status: 'completed', output: [] });
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, input: unansweredCallInput() }));

  expect(response.status).toBe(200);
  expect(calls).toBe(2);
  // The first attempt must be byte-identical to what the client sent: the
  // rewrite only happens after the upstream has already refused.
  expect(bodies[0]).toMatchObject({ input: [{ role: 'user' }, { type: 'function_call', call_id: 'call_1' }] });
  expect(bodies[1]).toMatchObject({
    input: [
      { role: 'user' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '[unanswered tool call: list_dir({"path":"."})]' }],
      },
    ],
  });
  await settleRecording(harness.recording);
  expect(attemptsOf(harness.recording)).toEqual([{ outcome: 'success', providerId: 'carpool', statusCode: 200 }]);
});

test('replays an orphan tool output 400 as a user note', async () => {
  let calls = 0;
  const bodies: unknown[] = [];
  const primary = responsesProvider(async (request) => {
    calls += 1;
    bodies.push(await request.clone().json());
    if (calls === 1) return pairingError('No tool call found for function call output with call_id call_9.');
    return Response.json({ id: 'resp_ok', status: 'completed', output: [] });
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  const response = await harness.run(
    jsonRequest({
      model: REQUESTED_MODEL,
      input: [{ type: 'function_call_output', call_id: 'call_9', output: 'done' }],
    }),
  );

  expect(response.status).toBe(200);
  expect(calls).toBe(2);
  expect(bodies[1]).toMatchObject({
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '[orphan tool result; call_id=call_9] done' }],
      },
    ],
  });
});

// The interleaved-message variant has a different root cause — an assistant
// message wedged between a call and its output — that a pairing rewrite cannot
// repair. Retrying would spend a billed round trip resending the same body.
test('forwards the interleaved-message 400 without a replay', async () => {
  let calls = 0;
  const primary = responsesProvider(async () => {
    calls += 1;
    return pairingError('No tool output found for tool call call_1.');
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, input: unansweredCallInput() }));

  expect(response.status).toBe(400);
  expect(calls).toBe(1);
  expect(await response.text()).toContain('No tool output found for tool call');
});

// Only one replay: a second 400 is returned as-is rather than starting another
// rewrite loop against a provider that keeps refusing.
test('returns the second 400 without a further replay', async () => {
  let calls = 0;
  const primary = responsesProvider(async () => {
    calls += 1;
    return pairingError('No tool output found for function call call_1.');
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, input: unansweredCallInput() }));

  expect(response.status).toBe(400);
  expect(calls).toBe(2);
});
