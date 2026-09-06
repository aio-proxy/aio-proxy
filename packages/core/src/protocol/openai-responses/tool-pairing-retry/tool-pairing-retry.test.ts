import { expect, test } from 'bun:test';

import { isToolPairingRejection, repairOpenAIResponsesToolPairing } from './tool-pairing-retry';

function errorPayload(message: string, code?: string | null): Record<string, unknown> {
  return { error: { type: 'invalid_request_error', code: code ?? null, message } };
}

test('recognizes the two repairable tool-pairing rejections', () => {
  expect(isToolPairingRejection(errorPayload('No tool call found for function call output with call_id call_7.'))).toBe(
    true,
  );
  expect(isToolPairingRejection(errorPayload('No tool output found for function call call_7.'))).toBe(true);
});

// A strict gateway emits this when an assistant message sits between a call and
// its output. Pairing cannot repair it, and claiming 'retry' would spend a
// billed round trip resending an unchanged body.
test('leaves the interleaved-message variant alone', () => {
  expect(isToolPairingRejection(errorPayload('No tool output found for tool call call_7.'))).toBe(false);
});

test('an explicit code outranks matching prose', () => {
  expect(
    isToolPairingRejection(errorPayload('No tool output found for function call call_7.', 'context_length_exceeded')),
  ).toBe(false);
  expect(isToolPairingRejection(errorPayload('Invalid value for model.'))).toBe(false);
  expect(isToolPairingRejection(undefined)).toBe(false);
});

test('narrates an unanswered call without fabricating its output', () => {
  const repaired = repairOpenAIResponsesToolPairing([
    { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
  ]);
  expect(repaired).toEqual([
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '[unanswered tool call: read_file({"path":"a"})]' }],
    },
  ]);
});

test('narrates an orphan output and keeps its non-text parts', () => {
  const repaired = repairOpenAIResponsesToolPairing([
    { type: 'function_call_output', call_id: 'call_9', output: 'done' },
    {
      type: 'custom_tool_call_output',
      call_id: 'call_10',
      output: [
        { type: 'output_text', text: 'summary' },
        { type: 'input_image', image_url: 'https://img.test/a.png' },
        { type: 'encrypted_content', encrypted_content: 'blob' },
      ],
    },
  ]);
  expect(repaired).toEqual([
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '[orphan tool result; call_id=call_9] done' }],
    },
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '[orphan tool result; call_id=call_10]' },
        { type: 'input_text', text: 'summary' },
        { type: 'input_image', image_url: 'https://img.test/a.png' },
      ],
    },
  ]);
});

test('leaves a well-formed transcript untouched', () => {
  expect(
    repairOpenAIResponsesToolPairing([
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ]),
  ).toBeUndefined();
});

// Same forward-pass rule as the model path's answeredCallIds: an output that
// precedes its call is an orphan, and the call it names stays unanswered. Both
// sides must agree, or one would treat a pair as sound while the other repairs it.
test('an output preceding its call leaves both sides unpaired', () => {
  const repaired = repairOpenAIResponsesToolPairing([
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
  ]);
  expect(repaired).toEqual([
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '[orphan tool result; call_id=call_1] ok' }],
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '[unanswered tool call: read_file({})]' }],
    },
  ]);
});

// The note may not be substituted in place here: call_1 is still awaiting its
// output, so a `message` item between them is exactly the interleaving
// isToolPairingRejection refuses to retry — the replay would earn a second 400.
// The note waits until the batch closes; every caller-sent item keeps its slot.
test('holds an unanswered-call note until the open batch closes', () => {
  const repaired = repairOpenAIResponsesToolPairing([
    { type: 'function_call', call_id: 'call_1', name: 'a', arguments: '{}' },
    { type: 'function_call', call_id: 'call_2', name: 'b', arguments: '{}' },
    { type: 'function_call', call_id: 'call_3', name: 'c', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    { type: 'function_call_output', call_id: 'call_3', output: 'ok' },
  ]);
  expect(repaired).toMatchObject([
    { type: 'function_call', call_id: 'call_1' },
    { type: 'function_call', call_id: 'call_3' },
    { type: 'function_call_output', call_id: 'call_1' },
    { type: 'function_call_output', call_id: 'call_3' },
    { type: 'message', role: 'assistant' },
  ]);
});

// Nothing is awaiting, so the note lands where the orphan stood.
test('emits a note in place when no batch is open', () => {
  expect(
    repairOpenAIResponsesToolPairing([
      { type: 'function_call_output', call_id: 'call_9', output: 'ok' },
      { type: 'message', role: 'user', content: 'next' },
    ]),
  ).toMatchObject([
    { type: 'message', role: 'user' },
    { type: 'message', role: 'user', content: 'next' },
  ]);
});

// functionCallOutputItemSchema allows an absent call_id: clients inject
// synthetic outputs identified by name instead. Nothing can pair them.
test('an output without call_id becomes an unlabelled orphan note', () => {
  expect(
    repairOpenAIResponsesToolPairing([{ type: 'function_call_output', name: 'send_message', output: 'ok' }]),
  ).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '[orphan tool result] ok' }] }]);
});

test('carries a custom tool call input verbatim', () => {
  expect(
    repairOpenAIResponsesToolPairing([{ type: 'custom_tool_call', call_id: 'call_1', name: 'exec', input: 'ls -la' }]),
  ).toEqual([
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '[unanswered tool call: exec(ls -la)]' }],
    },
  ]);
});
