import { describe, expect, test } from 'bun:test';

import type { GeminiFrame } from './gemini-generate-content.test-support';
import { collectSSE, partStream, writeGeminiGenerateContentSSE } from './gemini-generate-content.test-support';

describe('Gemini generateContent egress', () => {
  test('Given independent streams When encoded Then chunks share one local id and resolved model', async () => {
    const encode = async () => {
      const value = await collectSSE(
        writeGeminiGenerateContentSSE(
          partStream([
            { type: 'text-delta', id: 'text-1', text: 'Hello' },
            { type: 'finish', finishReason: 'stop', rawFinishReason: 'STOP', totalUsage: {} },
          ]),
          { modelId: 'gemini-routed' },
        ),
      );
      return value
        .trim()
        .split('\n\n')
        .map((frame) => JSON.parse(frame.slice('data: '.length)) as { responseId: string; modelVersion: string });
    };

    const [first, second] = await Promise.all([encode(), encode()]);
    expect(new Set(first.map((frame) => frame.responseId)).size).toBe(1);
    expect(first[0]?.responseId).not.toBe(second[0]?.responseId);
    expect(first.every((frame) => frame.modelVersion === 'gemini-routed')).toBe(true);
  });

  test('Given text stream When encoded as SSE Then emits exact Gemini frames', async () => {
    const stream = partStream([
      { type: 'text-delta', id: 'text-1', text: 'Hel' },
      { type: 'text-delta', id: 'text-1', text: 'lo' },
      {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'STOP',
        totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      },
    ]);

    const frames = (await collectSSE(writeGeminiGenerateContentSSE(stream)))
      .trim()
      .split('\n\n')
      .map((frame) => JSON.parse(frame.slice('data: '.length)) as GeminiFrame);
    expect(frames.map((frame) => frame.candidates[0].content.parts)).toEqual([[{ text: 'Hel' }], [{ text: 'lo' }], []]);
    expect(frames[2]).toMatchObject({
      modelVersion: 'test-model',
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    });
  });
});
