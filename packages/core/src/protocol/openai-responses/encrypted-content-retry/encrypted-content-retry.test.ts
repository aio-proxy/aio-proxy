import { expect, test } from 'bun:test';

import {
  classifyOpenAIResponsesRawRetry,
  looksLikeBackendCiphertext,
  openAIResponsesRawRetry,
  rewriteOpenAIResponsesEncryptedContent,
} from './encrypted-content-retry';

const CIPHER = `g${'A'.repeat(63)}`;
const ENCRYPTED_ERROR = JSON.stringify({
  type: 'error',
  error: { type: 'invalid_request_error', code: 'invalid_encrypted_content', message: 'x' },
});

test('rejects short or punctuated payloads as ciphertext', () => {
  expect(looksLikeBackendCiphertext('delegated task')).toBe(false);
  expect(looksLikeBackendCiphertext('a'.repeat(64))).toBe(true);
  expect(looksLikeBackendCiphertext(CIPHER)).toBe(true);
  expect(looksLikeBackendCiphertext('A'.repeat(63))).toBe(false);
  expect(looksLikeBackendCiphertext(`${'A'.repeat(60)} hello`)).toBe(false);
});

test('retries only invalid_encrypted_content', () => {
  expect(classifyOpenAIResponsesRawRetry({ event: 'error', data: ENCRYPTED_ERROR })).toBe('retry');
  expect(classifyOpenAIResponsesRawRetry({ data: ENCRYPTED_ERROR })).toBe('retry');
  expect(
    classifyOpenAIResponsesRawRetry({ event: 'error', data: '{"type":"error","error":{"code":"invalid_value"}}' }),
  ).toBe('commit');
});

// Official Responses / ChatGPT `event: error` puts `code` on the payload root.
// createOpenAIStreamFetch then rewrites that frame to response.failed with the
// code at response.error.code (see sse-terminal.recognition.test.ts).
test('retries a top-level Responses error code', () => {
  expect(
    classifyOpenAIResponsesRawRetry({
      event: 'error',
      data: JSON.stringify({
        type: 'error',
        code: 'invalid_encrypted_content',
        message: 'Encrypted function output content could not be decrypted or decoded.',
      }),
    }),
  ).toBe('retry');
  expect(
    classifyOpenAIResponsesRawRetry({
      event: 'error',
      data: JSON.stringify({ type: 'error', code: 'context_too_large', message: 'too big' }),
    }),
  ).toBe('commit');
});

test('retries a normalized response.failed envelope', () => {
  expect(
    classifyOpenAIResponsesRawRetry({
      event: 'response.failed',
      data: JSON.stringify({
        type: 'response.failed',
        response: {
          id: 'resp_1',
          status: 'failed',
          error: { type: 'error', code: 'invalid_encrypted_content', message: 'x' },
        },
      }),
    }),
  ).toBe('retry');
  expect(
    classifyOpenAIResponsesRawRetry({
      event: 'response.failed',
      data: JSON.stringify({
        type: 'response.failed',
        response: {
          id: 'resp_1',
          status: 'failed',
          error: {
            type: 'error',
            error: { type: 'invalid_request_error', code: 'invalid_encrypted_content', message: 'x' },
          },
        },
      }),
    }),
  ).toBe('retry');
  expect(
    classifyOpenAIResponsesRawRetry({
      event: 'response.failed',
      data: JSON.stringify({
        type: 'response.failed',
        response: { id: 'resp_1', status: 'failed', error: { type: 'error', code: 'context_too_large' } },
      }),
    }),
  ).toBe('commit');
});

// The repo's own Responses egress sends response.output_item.added immediately
// before each delta, so committing on it would forfeit the retry window. The
// *.added / *.done container frames announce or close an item without carrying
// generated output themselves.
test.each([
  ['response.created', '{"type":"response.created"}'],
  ['response.in_progress', '{"type":"response.in_progress"}'],
  ['response.queued', '{"type":"response.queued"}'],
  ['response.output_item.added', '{"type":"response.output_item.added","output_index":0}'],
  ['empty message item done', '{"type":"response.output_item.done","item":{"type":"message","content":[]}}'],
  ['empty reasoning item done', '{"type":"response.output_item.done","item":{"type":"reasoning","summary":[]}}'],
  ['response.content_part.added', '{"type":"response.content_part.added"}'],
  ['response.content_part.done', '{"type":"response.content_part.done"}'],
  ['response.reasoning_summary_part.added', '{"type":"response.reasoning_summary_part.added"}'],
  [undefined, 'not-json'],
])('holds pre-content frame %s', (event, data) => {
  expect(classifyOpenAIResponsesRawRetry(event === undefined ? { data } : { event, data })).toBe('hold');
});

// Every output-bearing member of the SDK's ResponseStreamEvent union, not just
// the text deltas. Holding any of these would let a later encrypted-content
// error replay a turn that already produced output.
test.each([
  ['response.output_text.delta', '{"type":"response.output_text.delta","delta":"hi"}'],
  ['response.output_text.done', '{"type":"response.output_text.done","text":"hi"}'],
  ['response.refusal.delta', '{"type":"response.refusal.delta","delta":"no"}'],
  ['response.refusal.done', '{"type":"response.refusal.done","refusal":"no"}'],
  ['response.reasoning_text.delta', '{"type":"response.reasoning_text.delta","delta":"hi"}'],
  ['response.reasoning_text.done', '{"type":"response.reasoning_text.done","text":"hi"}'],
  ['response.reasoning_summary_text.delta', '{"type":"response.reasoning_summary_text.delta","delta":"hi"}'],
  ['response.reasoning_summary_text.done', '{"type":"response.reasoning_summary_text.done","text":"hi"}'],
  ['response.function_call_arguments.delta', '{"type":"response.function_call_arguments.delta","delta":"{"}'],
  ['response.function_call_arguments.done', '{"type":"response.function_call_arguments.done","arguments":"{}"}'],
  ['response.custom_tool_call_input.delta', '{"type":"response.custom_tool_call_input.delta","delta":"p"}'],
  ['response.custom_tool_call_input.done', '{"type":"response.custom_tool_call_input.done","input":"pwd"}'],
  ['response.mcp_call_arguments.delta', '{"type":"response.mcp_call_arguments.delta","delta":"{"}'],
  ['response.code_interpreter_call_code.delta', '{"type":"response.code_interpreter_call_code.delta","delta":"1"}'],
  ['response.audio.delta', '{"type":"response.audio.delta","delta":"AA"}'],
  ['response.audio.transcript.delta', '{"type":"response.audio.transcript.delta","delta":"hi"}'],
  [
    'response.image_generation_call.partial_image',
    '{"type":"response.image_generation_call.partial_image","partial_image_index":0}',
  ],
  ['response.web_search_call.completed', '{"type":"response.web_search_call.completed","item_id":"ws_1"}'],
  ['response.image_generation_call.completed', '{"type":"response.image_generation_call.completed","item_id":"ig_1"}'],
  ['response.mcp_call.completed', '{"type":"response.mcp_call.completed","item_id":"mcp_1"}'],
])('commits output-bearing frame %s', (event, data) => {
  expect(classifyOpenAIResponsesRawRetry({ event, data })).toBe('commit');
});

// A built-in tool can deliver its whole result through output_item.done with no
// preceding delta, and event-counts bills image/web-search items from exactly
// that frame. Holding it would let a later error replay billable work.
test.each([
  ['image_generation_call', '{"type":"response.output_item.done","item":{"type":"image_generation_call","id":"ig_1"}}'],
  ['web_search_call', '{"type":"response.output_item.done","item":{"type":"web_search_call","id":"ws_1"}}'],
  ['function_call', '{"type":"response.output_item.done","item":{"type":"function_call","call_id":"c1"}}'],
  [
    'message with content',
    '{"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"hi"}]}}',
  ],
  [
    'reasoning with summary',
    '{"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"type":"summary_text","text":"t"}]}}',
  ],
  [
    'reasoning with encrypted_content',
    '{"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"gAAAA","summary":[]}}',
  ],
])('commits output_item.done carrying %s', (_name, data) => {
  expect(classifyOpenAIResponsesRawRetry({ event: 'response.output_item.done', data })).toBe('commit');
});

test.each([
  ['response.completed', '{"type":"response.completed","response":{"status":"completed"}}'],
  ['response.failed', '{"type":"response.failed","response":{"status":"failed"}}'],
  ['response.incomplete', '{"type":"response.incomplete"}'],
  ['response.cancelled', '{"type":"response.cancelled"}'],
])('commits terminal frame %s', (event, data) => {
  expect(classifyOpenAIResponsesRawRetry({ event, data })).toBe('commit');
});

test('rewrites plaintext agent_message encrypted_content to input_text', () => {
  const body = JSON.stringify({
    model: 'gpt-5.6-sol',
    input: [
      {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/review_t1',
        content: [
          { type: 'input_text', text: 'Payload:\n' },
          { type: 'encrypted_content', encrypted_content: 'delegated task' },
        ],
      },
    ],
  });
  expect(JSON.parse(rewriteOpenAIResponsesEncryptedContent(body)!)).toEqual({
    model: 'gpt-5.6-sol',
    input: [
      {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/review_t1',
        content: [
          { type: 'input_text', text: 'Payload:\n' },
          { type: 'input_text', text: 'delegated task' },
        ],
      },
    ],
  });
});

test('rewrites plaintext function_call_output encrypted_content parts', () => {
  const body = JSON.stringify({
    input: [
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [{ type: 'encrypted_content', encrypted_content: 'tool result' }],
      },
    ],
  });
  expect(JSON.parse(rewriteOpenAIResponsesEncryptedContent(body)!).input[0].output).toEqual([
    { type: 'input_text', text: 'tool result' },
  ]);
});

test('rewrites plaintext custom_tool_call_output encrypted_content parts', () => {
  const body = JSON.stringify({
    input: [
      {
        type: 'custom_tool_call_output',
        call_id: 'call_1',
        output: [{ type: 'encrypted_content', encrypted_content: 'tool result' }],
      },
    ],
  });
  expect(JSON.parse(rewriteOpenAIResponsesEncryptedContent(body)!).input[0].output).toEqual([
    { type: 'input_text', text: 'tool result' },
  ]);
});

test('leaves ciphertext parts untouched and falls through to the blob strip', () => {
  const body = JSON.stringify({
    input: [
      {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/w',
        content: [{ type: 'encrypted_content', encrypted_content: CIPHER }],
      },
      { type: 'reasoning', id: 'rs_1', encrypted_content: CIPHER, summary: [{ type: 'summary_text', text: 'think' }] },
    ],
  });
  expect(JSON.parse(rewriteOpenAIResponsesEncryptedContent(body)!)).toEqual({
    input: [
      {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/w',
        content: [{ type: 'encrypted_content', encrypted_content: CIPHER }],
      },
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'think' }] },
    ],
  });
});

test('strips reasoning and compaction blobs only when no plaintext slot changed', () => {
  const body = JSON.stringify({
    input: [
      { type: 'reasoning', encrypted_content: CIPHER, summary: [] },
      { type: 'compaction', encrypted_content: CIPHER },
      { type: 'compaction_summary', encrypted_content: CIPHER },
      { type: 'context_compaction', encrypted_content: CIPHER },
    ],
  });
  expect(JSON.parse(rewriteOpenAIResponsesEncryptedContent(body)!).input).toEqual([
    { type: 'reasoning', summary: [] },
    { type: 'compaction' },
    { type: 'compaction_summary' },
    { type: 'context_compaction' },
  ]);
});

test('returns undefined when there is nothing to rewrite', () => {
  expect(
    rewriteOpenAIResponsesEncryptedContent('{"input":[{"type":"message","role":"user","content":"hi"}]}'),
  ).toBeUndefined();
  expect(rewriteOpenAIResponsesEncryptedContent('not-json')).toBeUndefined();
});

test('hook rewrite carries the request forward and preserves the inbound signal', async () => {
  const controller = new AbortController();
  const source = new Request('https://upstream.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '5' },
    body: JSON.stringify({
      input: [
        {
          type: 'agent_message',
          author: '/root',
          recipient: '/root/w',
          content: [{ type: 'encrypted_content', encrypted_content: 'delegated task' }],
        },
      ],
    }),
    signal: controller.signal,
  });
  const retried = await openAIResponsesRawRetry.rewrite(source, {} as never, {});
  expect(retried).toBeDefined();
  expect(retried!.headers.get('content-length')).toBeNull();
  expect(retried!.signal.aborted).toBe(false);
  controller.abort();
  expect(retried!.signal.aborted).toBe(true);
  expect(await retried!.json()).toMatchObject({
    input: [{ type: 'agent_message', content: [{ type: 'input_text', text: 'delegated task' }] }],
  });
});

test('hook rewrite refuses the compact operation', async () => {
  const source = new Request('https://upstream.test/v1/responses/compact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: [
        {
          type: 'agent_message',
          author: '/root',
          recipient: '/root/w',
          content: [{ type: 'encrypted_content', encrypted_content: 'delegated task' }],
        },
      ],
    }),
  });
  expect(await openAIResponsesRawRetry.rewrite(source, {} as never, { operation: 'compact' })).toBeUndefined();
});
