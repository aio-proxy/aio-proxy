import { describe, expect, test } from 'bun:test';

import { createGoogleAntigravityRuntime } from './provider';
import { callOptions, runtimeContext, textResponse } from './provider.test-support';

describe('Google Antigravity ProviderV4', () => {
  test('builds the final runtime with ProviderV4, Gemini raw, and token-count capabilities', async () => {
    let envelope: Record<string, unknown> | undefined;
    const runtime = await createGoogleAntigravityRuntime(runtimeContext(), {
      fetch: async (_input, init) => {
        envelope = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ response: textResponse('runtime') });
      },
    });

    const result = await runtime.provider.languageModel('claude-sonnet-4-6').doGenerate({
      ...callOptions(),
      tools: [
        {
          type: 'function',
          name: 'weather',
          description: 'Forecast',
          inputSchema: {
            type: 'object',
            properties: { days: { type: 'number', enum: [1, 3], minLength: 1 } },
          },
        },
      ],
    } as never);

    expect(result.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'runtime' }));
    expect(envelope).toMatchObject({
      model: 'claude-sonnet-4-6',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: 'weather',
                parameters: {
                  type: 'object',
                  properties: {
                    days: expect.objectContaining({ type: 'string', enum: ['1', '3'] }),
                  },
                },
              },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
      },
    });
    expect(runtime.raw?.({ protocol: 'gemini', modelId: 'gemini-3-flash-agent' })).toBeDefined();
    expect(runtime.tokenCount).toBeDefined();
  });
});
