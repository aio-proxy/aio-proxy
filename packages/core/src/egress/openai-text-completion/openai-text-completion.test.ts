import { expect, test } from 'bun:test';

import type { TextStreamPart, ToolSet } from '../../ai-sdk-bridge';
import { writeOpenAITextCompletionResponse, writeOpenAITextCompletionSSE } from './openai-text-completion';

function oneDeltaFinishStream(): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'hello' });
      controller.enqueue({
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'stop',
        totalUsage: {},
      });
      controller.close();
    },
  });
}

async function decodeSse(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(decoder.decode(chunk, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}

test('writes official text_completion JSON from a one-delta finish stream', async () => {
  const json = await writeOpenAITextCompletionResponse(oneDeltaFinishStream(), { modelId: 'davinci' });

  expect(json.object).toBe('text_completion');
  expect(json.id.startsWith('cmpl-')).toBe(true);
  expect(json.created).toEqual(expect.any(Number));
  expect(json.model).toBe('davinci');
  expect(json.choices[0]).toMatchObject({ text: 'hello', index: 0, logprobs: null });
});

test('adopts upstream model and created but keeps the cmpl- id contract', async () => {
  const stream = new ReadableStream<TextStreamPart<ToolSet>>({
    start(controller) {
      controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'hello' });
      controller.enqueue({
        type: 'finish-step',
        response: {
          id: 'chatcmpl-upstream',
          modelId: 'gpt-upstream',
          timestamp: new Date('2026-07-12T00:00:05.000Z'),
        },
      } as never);
      controller.enqueue({ type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: {} });
      controller.close();
    },
  });

  const json = await writeOpenAITextCompletionResponse(stream, { modelId: 'davinci' });

  expect(json.model).toBe('gpt-upstream');
  expect(json.created).toBe(1_783_814_405);
  expect(json.id.startsWith('cmpl-')).toBe(true);
});

test('writes official text_completion SSE identity fields and ends with [DONE]', async () => {
  const text = await decodeSse(writeOpenAITextCompletionSSE(oneDeltaFinishStream(), { modelId: 'davinci' }));

  expect(text.endsWith('data: [DONE]\n\n')).toBe(true);

  const payloads = text
    .split('\n\n')
    .map((frame) => frame.replace(/^data: /, ''))
    .filter((payload) => payload.length > 0);

  for (const payload of payloads) {
    if (payload === '[DONE]') continue;
    const chunk = JSON.parse(payload) as {
      object: string;
      id: string;
      created: number;
      model: string;
      choices: readonly [{ index: number; logprobs: unknown }];
    };
    expect(chunk.object).toBe('text_completion');
    expect(chunk.id).toEqual(expect.any(String));
    expect(chunk.created).toEqual(expect.any(Number));
    expect(chunk.model).toBe('davinci');
    expect(chunk.choices[0]?.index).toBe(0);
    expect(chunk.choices[0]?.logprobs).toBe(null);
  }
});
