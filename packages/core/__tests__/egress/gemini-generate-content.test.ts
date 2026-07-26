import { describe, expect, test } from 'bun:test';

import {
  partStream,
  runtimePartStream,
  writeGeminiGenerateContentResponse,
} from './gemini-generate-content.test-support';

describe('Gemini generateContent egress', () => {
  test('Given finish-step metadata When encoded as response Then upstream response metadata is reused', async () => {
    const response = await writeGeminiGenerateContentResponse(
      runtimePartStream([
        { type: 'text-delta', id: 'text-1', text: 'Hello' },
        {
          type: 'finish-step',
          response: {
            id: 'gemini-upstream-id',
            modelId: 'gemini-upstream-model',
            timestamp: new Date('2026-07-12T00:00:05.000Z'),
          },
        },
        { type: 'finish', finishReason: 'stop', totalUsage: {} },
      ]) as never,
      { modelId: 'gemini-fallback' },
    );

    expect(response).toMatchObject({ responseId: 'gemini-upstream-id', modelVersion: 'gemini-upstream-model' });
  });

  test('Given text stream When encoded as response Then emits Gemini JSON', async () => {
    const stream = partStream([
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', text: 'Hel' },
      { type: 'text-delta', id: 'text-1', text: 'lo' },
      { type: 'text-end', id: 'text-1' },
      {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'STOP',
        totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      },
    ]);

    await expect(writeGeminiGenerateContentResponse(stream)).resolves.toMatchObject({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Hello' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 2,
        totalTokenCount: 5,
      },
      modelVersion: 'test-model',
    });
  });

  test('Given tool-call stream When encoded as response Then emits Gemini functionCall', async () => {
    const stream = partStream([
      { type: 'tool-input-start', id: 'call_1', toolName: 'lookup' },
      { type: 'tool-input-delta', id: 'call_1', delta: '{"q":"' },
      { type: 'tool-input-delta', id: 'call_1', delta: 'pizza"}' },
      { type: 'tool-input-end', id: 'call_1' },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        rawFinishReason: 'STOP',
        totalUsage: { inputTokens: undefined, outputTokens: 4, totalTokens: 9 },
      },
    ]);

    await expect(writeGeminiGenerateContentResponse(stream)).resolves.toMatchObject({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'lookup',
                  args: { q: 'pizza' },
                },
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        candidatesTokenCount: 4,
        totalTokenCount: 9,
      },
      modelVersion: 'test-model',
    });
  });
});
