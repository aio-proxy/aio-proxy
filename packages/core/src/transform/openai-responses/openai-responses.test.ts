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
    input: [{ type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{' }],
  });

  expect(() => openAIResponsesToModelMessages(request)).toThrow(new OpenAIResponsesTransformError('input.0.arguments'));
});

test('rejects a tool output without a call_id', () => {
  // Parse accepts it so raw passthrough can forward it, but the model path has
  // no call to pair it with.
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [{ type: 'function_call_output', name: 'send_message_to_thread', namespace: 'codex_app', output: 'hi' }],
  });

  expect(() => openAIResponsesToModelMessages(request)).toThrow(new OpenAIResponsesTransformError('input.0.call_id'));
});

test('converts empty function arguments to an empty object', () => {
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [{ type: 'function_call', call_id: 'call_1', name: 'get_goal', arguments: '' }],
  });

  expect(openAIResponsesToModelMessages(request).messages).toEqual([
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'get_goal', input: {} }],
    },
  ]);
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
