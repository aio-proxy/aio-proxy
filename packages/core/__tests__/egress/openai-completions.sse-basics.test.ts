import { describe, expect, test } from 'bun:test';

import type { TextStreamPart, ToolSet } from 'ai';

import {
  aiSdkPartStream,
  collectSSE,
  doneFrame,
  partStream,
  writeOpenAICompletionsSSE,
} from './openai-completions.test-support';

describe('writeOpenAICompletionsSSE', () => {
  test('Given downstream cancellation When source is open Then source is cancelled', async () => {
    let cancelCalls = 0;
    const source = new ReadableStream<TextStreamPart<ToolSet>>({
      start(controller) {
        controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'partial' });
      },
      cancel() {
        cancelCalls += 1;
      },
    });

    const reader = new Response(writeOpenAICompletionsSSE(source)).body?.getReader();
    await reader?.read();
    await reader?.cancel('client stopped');

    expect(cancelCalls).toBe(1);
  });

  test('Given stream egress context When encoded Then chunks include resolved model and creation time', async () => {
    const value = await collectSSE(
      writeOpenAICompletionsSSE(
        aiSdkPartStream([
          { type: 'text-delta', id: 'text-1', text: 'pong' },
          { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: {} },
        ]),
        { modelId: 'gpt-routed' },
      ),
      false,
    );
    const first = JSON.parse(value.split('\n')[0]?.slice('data: '.length) ?? 'null') as Record<string, unknown>;

    expect(first.model).toBe('gpt-routed');
    expect(first.created).toBeNumber();
  });

  test('Given AI SDK text stream When encoded Then uses text and total usage', async () => {
    const stream = aiSdkPartStream([
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', text: 'pong' },
      { type: 'text-end', id: 'text-1' },
      {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'stop',
        totalUsage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
    ]);

    await expect(collectSSE(writeOpenAICompletionsSSE(stream))).resolves.toBe(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"content":"pong"},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n' +
        doneFrame,
    );
  });

  test('Given text-only stream When encoded Then emits exact Chat SSE', async () => {
    const stream = partStream([
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'Hel' },
      { type: 'text-delta', id: 'text-1', delta: 'lo' },
      { type: 'text-end', id: 'text-1' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    ]);

    await expect(collectSSE(writeOpenAICompletionsSSE(stream))).resolves.toBe(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hel"},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"content":"lo"},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n' +
        doneFrame,
    );
  });
});
