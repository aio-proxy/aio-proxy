import { describe, expect, test } from 'bun:test';

import { createKimiRuntime } from './runtime';
import { catalog, context, validCredential } from './runtime.test-support';

describe('Kimi Code runtime', () => {
  test('selects converted language providers from catalog metadata', async () => {
    const runtime = await createKimiRuntime(context(validCredential(), catalog()));

    expect(runtime.provider.specificationVersion).toBe('v4');
    expect(runtime.provider.languageModel('openai-model').provider).toContain('openai-compatible');
    expect(runtime.provider.languageModel('anthropic-model').provider).toContain('anthropic');
    expect(() => runtime.provider.languageModel('missing')).toThrow('missing');
  });

  for (const scenario of [
    {
      modelId: 'openai-model',
      url: 'https://api.kimi.com/coding/v1/chat/completions',
      response: {
        id: 'chatcmpl-test',
        created: 1,
        model: 'openai-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    },
    {
      modelId: 'anthropic-model',
      url: 'https://api.kimi.com/coding/v1/messages',
      response: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'anthropic-model',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ] as const) {
    test(`${scenario.modelId} generation uses the Kimi endpoint and current identity`, async () => {
      const calls: Request[] = [];
      const signals: (AbortSignal | null | undefined)[] = [];
      const runtime = await createKimiRuntime(context(validCredential('current-token'), catalog()), {
        fetch: async (input, init) => {
          calls.push(new Request(input, init));
          signals.push(init?.signal);
          return Response.json(scenario.response);
        },
      });
      const controller = new AbortController();

      await runtime.provider.languageModel(scenario.modelId).doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        abortSignal: controller.signal,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(scenario.url);
      expect(calls[0]?.method).toBe('POST');
      expect(signals[0]).toBe(controller.signal);
      expect(calls[0]?.headers.get('authorization')).toBe('Bearer current-token');
      expect(calls[0]?.headers.get('x-msh-device-id')).toBe('device-1');
      expect(calls[0]?.headers.get('x-api-key')).toBeNull();
      expect(calls[0]?.headers.get('anthropic-api-key')).toBeNull();
      expect(JSON.stringify([...(calls[0]?.headers ?? new Headers())])).not.toContain('dynamic-credential');
    });
  }
});
