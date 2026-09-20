import { describe, expect, test } from 'bun:test';

import {
  collectSSE,
  doneFrame,
  partStream,
  runtimePartStream,
  writeOpenAICompletionsSSE,
} from './openai-completions.test-support';

type MergedToolCall = { id: string; type: string; name: string; arguments: string };

// Mirrors a Chat Completions client: tool calls are keyed by index and every string field the
// chunks carry is concatenated. Repeating a field across chunks shows up as a doubled value.
function mergeToolCalls(sse: string): Map<number, MergedToolCall> {
  const merged = new Map<number, MergedToolCall>();
  for (const block of sse.split('\n\n')) {
    if (!block.startsWith('data: {')) continue;
    const chunk = JSON.parse(block.slice('data: '.length)) as {
      choices?: Array<{
        delta?: {
          tool_calls?: Array<{
            index: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };
    for (const toolCall of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
      const current = merged.get(toolCall.index) ?? { id: '', type: '', name: '', arguments: '' };
      merged.set(toolCall.index, {
        id: current.id + (toolCall.id ?? ''),
        type: current.type + (toolCall.type ?? ''),
        name: current.name + (toolCall.function?.name ?? ''),
        arguments: current.arguments + (toolCall.function?.arguments ?? ''),
      });
    }
  }
  return merged;
}

describe('writeOpenAICompletionsSSE', () => {
  test('Given tool-call stream When encoded Then repeats only the index after the first chunk', async () => {
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

    const sse = await collectSSE(writeOpenAICompletionsSSE(stream));
    expect(sse).toBe(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":""}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":\\""}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"pizza\\"}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}],"usage":{"total_tokens":9}}\n\n' +
        doneFrame,
    );
    expect(mergeToolCalls(sse).get(0)).toEqual({
      id: 'call_1',
      type: 'function',
      name: 'lookup',
      arguments: '{"q":"pizza"}',
    });
  });

  test('Given empty tool-input-delta When encoded Then skips the empty chunk', async () => {
    const stream = partStream([
      { type: 'tool-input-start', id: 'call_1', toolName: 'lookup' },
      { type: 'tool-input-delta', id: 'call_1', delta: '' },
      { type: 'tool-input-delta', id: 'call_1', delta: '{"q":1}' },
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
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":""}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":1}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}]}\n\n' +
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
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"index":0}]}\n\n' +
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

    const sse = await collectSSE(writeOpenAICompletionsSSE(stream));
    expect(sse).toBe(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_b","type":"function","function":{"name":"second","arguments":""}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_a","type":"function","function":{"name":"first","arguments":""}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"a\\":1}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"b\\":2}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}]}\n\n' +
        doneFrame,
    );
    expect(mergeToolCalls(sse)).toEqual(
      new Map([
        [0, { id: 'call_b', type: 'function', name: 'second', arguments: '{"b":2}' }],
        [1, { id: 'call_a', type: 'function', name: 'first', arguments: '{"a":1}' }],
      ]),
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
