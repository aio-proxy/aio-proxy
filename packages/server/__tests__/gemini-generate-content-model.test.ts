import { describe, expect, test } from 'bun:test';

import type { ModelMessage } from 'ai';

import {
  aiSdkProvider,
  appWith,
  type ProviderSeenSettings,
  postGenerate,
  textStream,
} from './gemini-generate-content.test-support';

describe('POST /v1beta/models/:model::generateContent', () => {
  test('Given ai-sdk provider When generateContent is posted Then Gemini JSON is returned', async () => {
    // Given
    let messagesSeen: readonly ModelMessage[] | undefined;
    let modelSeen: string | undefined;
    let settingsSeen: ProviderSeenSettings | undefined;
    const provider = aiSdkProvider((request) => {
      messagesSeen = request.messages;
      modelSeen = request.modelId;
      settingsSeen = request.settings;
      return textStream([
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
    });
    const app = await appWith(provider);

    // When
    const response = await postGenerate(app);
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(messagesSeen).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hello proxy' }] }]);
    expect(modelSeen).toBe('gemini-2.5-flash');
    expect(settingsSeen).toEqual({});
    expect(body).toMatchObject({
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
      modelVersion: 'gemini-2.5-flash',
    });
    expect(body.responseId).toStartWith('resp_');
  });
});

describe('POST /v1beta/models/:model::streamGenerateContent', () => {});
