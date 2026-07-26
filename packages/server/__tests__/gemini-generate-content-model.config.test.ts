import { describe, expect, test } from 'bun:test';

import { type AiSdkProviderInstance } from '@aio-proxy/core';
import type { ToolSet } from 'ai';
import { asSchema } from 'ai';

import {
  aiSdkProvider,
  appWith,
  generateRequest,
  type ProviderSeenSettings,
  postGenerate,
  textStream,
} from './gemini-generate-content.test-support';

describe('POST /v1beta/models/:model::generateContent', () => {
  test('Given an alias variant and ai-sdk provider When generateContent is posted Then reasoning selects and configures it', async () => {
    // Given
    let modelSeen: string | undefined;
    let settingsSeen: ProviderSeenSettings | undefined;
    const provider = {
      id: 'mock-ai',
      kind: 'ai-sdk',
      models: ['gemini-default', 'gemini-high'],
      alias: {
        'gemini-alias': {
          model: 'gemini-default',
          preserve: false,
          variants: { high: { model: 'gemini-high', preserve: false } },
        },
      },
      invoke(request) {
        modelSeen = request.modelId;
        settingsSeen = request.settings;
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await appWith(provider);

    // When
    const response = await postGenerate(
      app,
      {
        ...generateRequest,
        generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } },
      },
      'gemini-alias',
    );
    await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(modelSeen).toBe('gemini-high');
    expect(settingsSeen).toEqual({ reasoning: 'high' });
  });

  test('Given tools and safetySettings When generateContent is posted Then provider receives them', async () => {
    // Given
    const parameters = {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    };
    const safetySettings = [
      {
        category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
        threshold: 'BLOCK_ONLY_HIGH',
      },
    ];
    let settingsSeen: ProviderSeenSettings | undefined;
    let toolsSeen: ToolSet | undefined;
    const provider = aiSdkProvider((request) => {
      settingsSeen = request.settings;
      toolsSeen = request.tools;
      return textStream([
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', text: 'ok' },
        { type: 'text-end', id: 'text-1' },
      ]);
    });
    const app = await appWith(provider);

    // When
    const response = await postGenerate(app, {
      contents: [{ role: 'user', parts: [{ text: 'Weather?' }] }],
      generationConfig: { temperature: 0.2 },
      safetySettings,
      tools: [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Returns weather for a city.',
              parameters,
            },
          ],
        },
      ],
    });

    // Then
    const weatherTool = toolsSeen?.get_weather;
    if (weatherTool === undefined) {
      throw new Error('Expected provider to receive get_weather tool');
    }

    expect(response.status).toBe(200);
    expect(settingsSeen).toEqual({
      temperature: 0.2,
      providerOptions: { google: { safetySettings } },
    });
    expect(weatherTool.type).toBe('function');
    expect(weatherTool.description).toBe('Returns weather for a city.');
    expect(await asSchema(weatherTool.inputSchema).jsonSchema).toEqual(parameters);
  });
});
