import { expect, spyOn, test } from 'bun:test';

import {
  OpenAIResponsesTransformError,
  OpenAIResponsesUnsupportedFeatureError,
  openAIResponsesToModelMessages,
  parseOpenAIResponses,
} from '../../index';

test('converts a developer message to a system message', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [{ role: 'developer', content: 'You are a coding agent.' }],
  });

  try {
    expect(openAIResponsesToModelMessages(request).messages).toEqual([
      {
        role: 'system',
        content: 'You are a coding agent.',
        providerOptions: {
          aioProxy: {
            openaiResponses: {
              protocol: 'openai-responses',
              inputIndex: 0,
              itemType: 'message',
              wireRole: 'developer',
            },
          },
        },
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      '[aio-proxy] OpenAI Responses model conversion degraded',
      'message.role.developer',
      'input.0.role',
      'converted',
    );
  } finally {
    warn.mockRestore();
  }
});

test('prepends top-level instructions as a system message', () => {
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    instructions: 'Follow the repository guidance.',
    input: 'hello',
  });

  expect(openAIResponsesToModelMessages(request).messages).toEqual([
    { role: 'system', content: 'Follow the repository guidance.' },
    { role: 'user', content: 'hello' },
  ]);
});

test('omits null top-level instructions on the model path', () => {
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    instructions: null,
    input: 'hello',
  });

  expect(openAIResponsesToModelMessages(request).messages).toEqual([{ role: 'user', content: 'hello' }]);
});

test('drops hosted web search on the model path', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: 'hello',
    tools: [{ type: 'web_search' }],
  });

  try {
    expect(openAIResponsesToModelMessages(request).tools).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[aio-proxy] OpenAI Responses model conversion degraded',
      'web_search',
      'tools.0.type',
      'dropped',
    );
  } finally {
    warn.mockRestore();
  }
});

test('converts function-call history', () => {
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'contents' },
    ],
  });

  expect(openAIResponsesToModelMessages(request).messages).toEqual([
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'read_file',
          input: { path: 'README.md' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'read_file',
          output: { type: 'text', value: 'contents' },
        },
      ],
    },
  ]);
});

test('keeps a reasoning summary with its preceding function call', () => {
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"README.md"}' },
      {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'I will inspect the requested file.' }],
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'contents' },
    ],
  });

  const messages = openAIResponsesToModelMessages(request).messages;

  expect(messages.map((message) => message.role)).toEqual(['assistant', 'tool']);
  expect(messages[0]).toMatchObject({
    role: 'assistant',
    content: [
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'read_file', input: { path: 'README.md' } },
      { type: 'reasoning', text: 'I will inspect the requested file.' },
    ],
  });
  expect(messages[1]).toMatchObject({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call_1',
        toolName: 'read_file',
        output: { type: 'text', value: 'contents' },
      },
    ],
  });
});

test('converts reasoning summary and drops encrypted content on the model path', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const reasoning = {
    type: 'reasoning' as const,
    id: 'rs_1',
    encrypted_content: 'opaque',
    summary: [{ type: 'summary_text' as const, text: 'Do not expose this.' }],
  };
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [reasoning, { role: 'user', content: 'hello' }],
  });

  try {
    expect(openAIResponsesToModelMessages(request).messages).toMatchObject([
      { role: 'assistant', content: [{ type: 'reasoning', text: 'Do not expose this.' }] },
      { role: 'user', content: 'hello' },
    ]);
    expect(warn).toHaveBeenCalledWith(
      '[aio-proxy] OpenAI Responses model conversion degraded',
      'reasoning.encrypted_content',
      'input.0.encrypted_content',
      'dropped',
    );
  } finally {
    warn.mockRestore();
  }
});

test('rejects an item reference on the model path', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const reference = { type: 'item_reference' as const, id: 'item_1' };
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [reference, { role: 'user', content: 'hello' }],
  });

  try {
    expect(() => openAIResponsesToModelMessages(request)).toThrow(
      new OpenAIResponsesUnsupportedFeatureError('item_reference', 'input.0.type'),
    );
    expect(warn).toHaveBeenCalledWith(
      '[aio-proxy] OpenAI Responses model conversion degraded',
      'item_reference',
      'input.0.type',
      'rejected',
    );
  } finally {
    warn.mockRestore();
  }
});

test('rejects invalid function arguments', () => {
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ],
  });

  expect(() => openAIResponsesToModelMessages(request)).toThrow(new OpenAIResponsesTransformError('input.0.arguments'));
});

test('rejects a tool output without a call_id as an unsupported feature', () => {
  // Parse accepts it so raw passthrough can forward it. A model-only candidate
  // cannot pair it with a call, and must reject in a way the pipeline can fall
  // back from — a terminal 400 would skip a later raw candidate.
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [{ type: 'function_call_output', name: 'send_message_to_thread', namespace: 'codex_app', output: 'hi' }],
  });

  try {
    expect(() => openAIResponsesToModelMessages(request)).toThrow(
      new OpenAIResponsesUnsupportedFeatureError('function_call_output.call_id', 'input.0.call_id'),
    );
  } finally {
    warn.mockRestore();
  }
});

test('converts a tool output whose call was truncated away into a user note', () => {
  // Context compaction can drop a function_call while keeping its output (Codex
  // truncates guardian_history between the two). Neither path can pair it — raw
  // passthrough gets `400 No tool call found for function call output` upstream.
  // A proxy must not discard the payload, so it is carried through as a note.
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [
      { type: 'function_call_output', call_id: 'call_gone', output: 'exit code 0' },
      { role: 'user', content: 'continue' },
    ],
  });

  try {
    const invocation = openAIResponsesToModelMessages(request);
    expect(invocation.messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: '[orphan tool result; call_id=call_gone] exit code 0' }],
    });
    expect(invocation.messages[1]).toMatchObject({ role: 'user', content: 'continue' });
    expect(invocation.diagnostics).toEqual([
      {
        feature: 'orphan_tool_call_output',
        action: 'converted',
        reason: 'call_id_without_matching_call',
        inputIndex: 0,
      },
    ]);
  } finally {
    warn.mockRestore();
  }
});

test('keeps image parts of an orphan tool output instead of dropping them', () => {
  // The note is the only carrier left for this payload, so it must not be
  // reduced to text — an image in a tool result is content the caller sent.
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [
      {
        type: 'function_call_output',
        call_id: 'call_gone',
        output: [
          { type: 'output_text', text: 'rendered' },
          { type: 'input_image', image_url: 'https://example.test/a.png' },
        ],
      },
    ],
  });

  try {
    const invocation = openAIResponsesToModelMessages(request);
    expect(invocation.messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: '[orphan tool result; call_id=call_gone]' },
        { type: 'text', text: 'rendered' },
        { type: 'file' },
      ],
    });
  } finally {
    warn.mockRestore();
  }
});

test('pairs a tool output with its call and does not treat it as an orphan', () => {
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ],
  });

  const invocation = openAIResponsesToModelMessages(request);
  expect(invocation.messages[1]).toMatchObject({
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'read_file' }],
  });
  expect(invocation.diagnostics ?? []).toEqual([]);
});

test('treats an output preceding its call as an orphan', () => {
  // Unlike the Codex client, which repairs items in place within the Responses
  // grammar, this path emits an ordered message sequence: a tool-result before
  // its tool-call has nothing to attach to. Carrying it as a note keeps the
  // payload without emitting a message order no provider would accept.
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [
      { type: 'function_call_output', call_id: 'call_1', output: 'stale' },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
    ],
  });

  try {
    const invocation = openAIResponsesToModelMessages(request);
    expect(invocation.messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: '[orphan tool result; call_id=call_1] stale' }],
    });
    // The call must not count as answered by an output that precedes it, or both
    // sides would claim to be paired while only one of them emitted a part.
    expect(invocation.messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: '[unanswered tool call: read_file({})]' }],
    });
  } finally {
    warn.mockRestore();
  }
});

test('narrates a tool call that no output answers instead of emitting a dangling call', () => {
  // An unanswered call is rejected upstream (`400 No tool output found for
  // function call …`, and Anthropic refuses a tool_use with no tool_result).
  // Synthesizing an output would invent a tool return the caller never sent, so
  // the call is narrated instead — the action survives, the result is not faked.
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [
      { type: 'function_call', call_id: 'call_dropped', name: 'read_file', arguments: '{"path":"a"}' },
      { role: 'user', content: 'continue' },
    ],
  });

  try {
    const invocation = openAIResponsesToModelMessages(request);
    expect(invocation.messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '[unanswered tool call: read_file({"path":"a"})]' }],
    });
    expect(invocation.messages[1]).toMatchObject({ role: 'user', content: 'continue' });
    expect(invocation.diagnostics).toEqual([
      {
        feature: 'unanswered_tool_call',
        action: 'converted',
        reason: 'call_without_matching_output',
        inputIndex: 0,
      },
    ]);
  } finally {
    warn.mockRestore();
  }
});

test('carries unanswered call arguments verbatim so the text stays byte-stable', () => {
  // Re-serializing would change key order and spacing between turns, breaking
  // upstream prefix caching for a conversation that keeps replaying this item.
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [{ type: 'function_call', call_id: 'call_1', name: 'run', arguments: '{ "b":2,  "a":1 }' }],
  });

  try {
    expect(openAIResponsesToModelMessages(request).messages[0]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: '[unanswered tool call: run({ "b":2,  "a":1 })]' }],
    });
  } finally {
    warn.mockRestore();
  }
});

test('narrates only the unanswered call of a parallel batch', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
      { type: 'function_call', call_id: 'call_2', name: 'write_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ],
  });

  try {
    const invocation = openAIResponsesToModelMessages(request);
    expect(invocation.messages).toMatchObject([
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'read_file' },
          { type: 'text', text: '[unanswered tool call: write_file({})]' },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1' }] },
    ]);
  } finally {
    warn.mockRestore();
  }
});

test('keeps a batch together when an unanswered call sits between two answered ones', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
      { type: 'function_call', call_id: 'call_2', name: 'write_file', arguments: '{}' },
      { type: 'function_call', call_id: 'call_3', name: 'list_dir', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      { type: 'function_call_output', call_id: 'call_3', output: 'ok' },
    ],
  });

  try {
    // call_3 must stay in the first assistant message: a second assistant turn
    // between call_1 and its result is the dangling-call ordering upstreams reject.
    const invocation = openAIResponsesToModelMessages(request);
    expect(invocation.messages).toMatchObject([
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'read_file' },
          { type: 'text', text: '[unanswered tool call: write_file({})]' },
          { type: 'tool-call', toolCallId: 'call_3', toolName: 'list_dir' },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'call_1' },
          { type: 'tool-result', toolCallId: 'call_3' },
        ],
      },
    ]);
  } finally {
    warn.mockRestore();
  }
});

test('converts empty function arguments to an empty object', () => {
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'get_goal', arguments: '' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ],
  });

  expect(openAIResponsesToModelMessages(request).messages[0]).toEqual({
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'get_goal', input: {} }],
  });
});

test('groups consecutive parallel calls and outputs', () => {
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
      { type: 'function_call', call_id: 'call_2', name: 'read_file', arguments: '{"path":"b"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'A' },
      { type: 'function_call_output', call_id: 'call_2', output: 'B' },
    ],
  });

  expect(openAIResponsesToModelMessages(request).messages).toEqual([
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'read_file', input: { path: 'a' } },
        { type: 'tool-call', toolCallId: 'call_2', toolName: 'read_file', input: { path: 'b' } },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'read_file',
          output: { type: 'text', value: 'A' },
        },
        {
          type: 'tool-result',
          toolCallId: 'call_2',
          toolName: 'read_file',
          output: { type: 'text', value: 'B' },
        },
      ],
    },
  ]);
});

test('converts text function output content', () => {
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'first' },
          { type: 'input_text', text: 'second' },
        ],
      },
    ],
  });

  expect(openAIResponsesToModelMessages(request).messages.at(1)).toEqual({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call_1',
        toolName: 'read_file',
        output: {
          type: 'content',
          value: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        },
      },
    ],
  });
});

test('rejects store true on the model path', () => {
  const request = parseOpenAIResponses({ model: 'gpt-5.6-terra', input: 'hello', store: true });

  expect(() => openAIResponsesToModelMessages(request)).toThrow(
    new OpenAIResponsesUnsupportedFeatureError('store', 'store'),
  );
});

test('disables response storage on the model path', () => {
  const request = parseOpenAIResponses({ model: 'gpt-5.6-terra', input: 'hello' });

  expect(openAIResponsesToModelMessages(request).settings.providerOptions).toEqual({ openai: { store: false } });
});
