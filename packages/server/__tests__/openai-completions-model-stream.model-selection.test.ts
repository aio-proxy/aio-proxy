import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { AiSdkProviderInstance, ApiProviderInstance } from '@aio-proxy/core';
import { createServer } from '@aio-proxy/server';
import { ProviderProtocol } from '@aio-proxy/types';
import type { CallSettings, ToolSet } from 'ai';

import { chatRequest, mockModelsDevCatalog, restoreFetch, textStream } from './openai-completions.test-support';

beforeEach(mockModelsDevCatalog);
afterEach(restoreFetch);

describe('POST /v1/chat/completions', () => {
  test('Given cross-protocol provider with model capability When completion has function tools Then model receives tools', async () => {
    let toolsSeen: ToolSet | undefined;
    const passthrough = async () => Response.json({ transport: 'raw' });
    const provider = {
      id: 'anthropic-bridge',
      kind: 'api',
      models: ['gpt-4o-mini'],
      alias: { 'gpt-4o-mini': { model: 'gpt-4o-mini', preserve: false } },
      protocol: ProviderProtocol.Anthropic,
      endpointTransports: [{ protocol: ProviderProtocol.Anthropic, passthrough }],
      passthrough,
      model: {
        invoke(request) {
          toolsSeen = request.tools;
          return textStream([
            {
              type: 'finish',
              finishReason: 'stop',
              rawFinishReason: 'stop',
              totalUsage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
            },
          ]);
        },
      },
    } satisfies ApiProviderInstance & { model: { invoke: AiSdkProviderInstance['invoke'] } };
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });

    const response = await app.request('/v1/chat/completions', {
      body: JSON.stringify({
        ...chatRequest,
        stream: false,
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Look up a value',
              parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
            },
          },
        ],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(Object.keys(toolsSeen ?? {})).toEqual(['lookup']);
    expect(response.status).toBe(200);
  });

  test('Given an alias variant and ai-sdk provider When completion is posted Then reasoning selects and configures it', async () => {
    // Given
    let modelSeen: string | undefined;
    let settingsSeen: CallSettings | undefined;
    const provider = {
      id: 'mock-ai',
      kind: 'ai-sdk',
      models: ['gpt-default', 'gpt-high'],
      alias: {
        mini: {
          model: 'gpt-default',
          preserve: false,
          variants: { high: { model: 'gpt-high', preserve: false } },
        },
      },
      invoke(request) {
        modelSeen = request.modelId;
        settingsSeen = request.settings;
        return textStream([
          {
            type: 'finish',
            finishReason: 'stop',
            rawFinishReason: 'stop',
            totalUsage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
          },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });

    // When
    const response = await app.request('/v1/chat/completions', {
      body: JSON.stringify({ ...chatRequest, model: 'mini', reasoning_effort: 'high' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(modelSeen).toBe('gpt-high');
    expect(settingsSeen).toEqual({ reasoning: 'high', stream: true });
  });
});
