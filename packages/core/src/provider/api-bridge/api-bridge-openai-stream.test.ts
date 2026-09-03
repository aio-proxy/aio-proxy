import { describe, expect, test } from 'bun:test';

import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { jsonSchema } from 'ai';

import { bridgeApiProviderToAiSdk } from '../../index';
import {
  OPENAI_COMPATIBLE_TERMINAL,
  OPENAI_RESPONSES_TERMINAL,
  terminalThenErrorFetch,
} from '../openai-stream-fetch-test-helpers';
import { collect, messages } from './api-bridge-test-helpers';

Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false });

const cases = [
  { protocol: ProviderProtocol.OpenAIResponse, terminal: OPENAI_RESPONSES_TERMINAL },
  { protocol: ProviderProtocol.OpenAICompatible, terminal: OPENAI_COMPATIBLE_TERMINAL },
] as const;

describe('bridgeApiProviderToAiSdk OpenAI stream protection', () => {
  for (const { protocol, terminal } of cases) {
    test(`${protocol} finishes without observing a late body decode error`, async () => {
      const upstream = terminalThenErrorFetch({ terminal });
      const bridge = bridgeApiProviderToAiSdk(
        {
          kind: ProviderKind.Api,
          id: `bridge-${protocol}`,
          protocol,
          apiKey: 'test',
          baseURL: 'https://upstream.test/v1',
          models: ['gpt-test'],
        },
        { fetch: upstream.fetch },
      );
      const parts = await collect(bridge.invoke({ messages, modelId: 'gpt-test' }));
      expect(parts.some((part) => part.type === 'finish')).toBe(true);
      expect(parts.some((part) => part.type === 'error')).toBe(false);
      expect(upstream.secondPulls()).toBe(0);
      expect(upstream.cancelled()).toBe(true);
    });
  }

  test('normalizes cumulative compatible tool arguments before AI SDK parsing', async () => {
    const chunk = (argumentsText: string) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-tool',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'exec', arguments: argumentsText },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`;
    const upstream =
      chunk(`{"`) +
      chunk(`{"input"`) +
      chunk(`{"input":"pwd"}`) +
      'data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","created":0,"model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
      'data: [DONE]\n\n';
    const bridge = bridgeApiProviderToAiSdk(
      {
        kind: ProviderKind.Api,
        id: 'compatible',
        protocol: ProviderProtocol.OpenAICompatible,
        apiKey: 'test',
        baseURL: 'https://upstream.test/v1',
        models: ['gpt-test'],
      },
      { fetch: async () => new Response(upstream, { headers: { 'content-type': 'text/event-stream' } }) },
    );

    const parts = await collect(
      bridge.invoke({
        messages,
        modelId: 'gpt-test',
        tools: {
          exec: {
            type: 'function',
            inputSchema: jsonSchema({
              type: 'object',
              properties: { input: { type: 'string' } },
              required: ['input'],
              additionalProperties: false,
            }),
            metadata: {
              aioProxy: {
                openaiResponses: {
                  protocol: 'openai-responses',
                  wireToolType: 'custom',
                  wireToolName: 'exec',
                },
              },
            },
          },
        },
      }),
    );

    expect(parts.find((part) => part.type === 'tool-input-start')).toMatchObject({
      type: 'tool-input-start',
      id: 'call-1',
      toolName: 'exec',
      toolMetadata: { aioProxy: { openaiResponses: { wireToolType: 'custom' } } },
    });
    expect(parts.find((part) => part.type === 'tool-call')).toMatchObject({
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'exec',
      input: { input: 'pwd' },
    });
  });
});
