import { describe, expect, test } from 'bun:test';

import {
  collectSSE,
  doneFrame,
  partStream,
  runtimePartStream,
  writeOpenAICompletionsSSE,
} from './openai-completions.test-support';

describe('writeOpenAICompletionsSSE', () => {
  test('Given tool-call stream When encoded Then emits accumulated arguments', async () => {
    const stream = partStream([
      { type: 'tool-input-start', id: 'call_1', toolName: 'lookup' },
      { type: 'tool-input-delta', id: 'call_1', delta: '{"q":"' },
      { type: 'tool-input-delta', id: 'call_1', delta: 'pizza"}' },
      { type: 'tool-input-end', id: 'call_1' },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: 9,
        },
      },
    ]);

    await expect(collectSSE(writeOpenAICompletionsSSE(stream))).resolves.toBe(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":""}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":\\""}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":\\"pizza\\"}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":\\"pizza\\"}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}],"usage":{"total_tokens":9}}\n\n' +
        doneFrame,
    );
  });

  test('Given mixed text and tool stream When encoded Then preserves chunk order', async () => {
    const stream = partStream([
      { type: 'text-delta', id: 'text-1', delta: 'Checking ' },
      { type: 'tool-input-start', id: 'call_1', toolName: 'lookup' },
      { type: 'tool-input-delta', id: 'call_1', delta: '{}' },
      { type: 'tool-input-end', id: 'call_1' },
      { type: 'text-delta', id: 'text-1', delta: 'done' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        },
      },
    ]);

    await expect(collectSSE(writeOpenAICompletionsSSE(stream))).resolves.toBe(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"content":"Checking "},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":""}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"content":"done"},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n\n' +
        doneFrame,
    );
  });

  test('Given multiple tools When encoded Then indexes follow stream order', async () => {
    const stream = partStream([
      { type: 'tool-input-start', id: 'call_b', toolName: 'second' },
      { type: 'tool-input-start', id: 'call_a', toolName: 'first' },
      { type: 'tool-input-delta', id: 'call_a', delta: '{"a":1}' },
      { type: 'tool-input-delta', id: 'call_b', delta: '{"b":2}' },
      { type: 'tool-input-end', id: 'call_a' },
      { type: 'tool-input-end', id: 'call_b' },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        },
      },
    ]);

    await expect(collectSSE(writeOpenAICompletionsSSE(stream))).resolves.toBe(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_b","type":"function","function":{"name":"second","arguments":""}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_a","type":"function","function":{"name":"first","arguments":""}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_a","type":"function","function":{"name":"first","arguments":"{\\"a\\":1}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_b","type":"function","function":{"name":"second","arguments":"{\\"b\\":2}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_a","type":"function","function":{"name":"first","arguments":"{\\"a\\":1}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_b","type":"function","function":{"name":"second","arguments":"{\\"b\\":2}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}]}\n\n' +
        doneFrame,
    );
  });

  test('Given unknown raw and error parts When encoded Then skips them and emits DONE', async () => {
    const stream = runtimePartStream([
      { type: 'text-delta', id: 'text-1', delta: 'safe' },
      { type: 'raw', rawValue: { ignored: true } },
      { type: '__future-part', payload: 'ignored' },
      { type: 'error', error: new Error('ignored') },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        },
      },
    ]);

    await expect(collectSSE(writeOpenAICompletionsSSE(stream))).resolves.toBe(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"content":"safe"},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n\n' +
        doneFrame,
    );
  });
});
