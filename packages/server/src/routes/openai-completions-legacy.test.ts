import { describe, expect, test } from 'bun:test';

import { createServer } from '#server-test-lifecycle';

import { aiSdkProvider, textStream } from '../../__tests__/openai-responses.test-support';

const model = 'gpt-4.1-mini';

function completionsProvider(onInvoke?: () => void) {
  return aiSdkProvider(() => {
    onInvoke?.();
    return textStream([
      { type: 'text-delta', id: 'text-1', text: 'hello' },
      {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'stop',
        totalUsage: {},
      },
    ]);
  });
}

describe('POST /v1/completions', () => {
  test('Given a model-only ai-sdk provider When prompt is posted Then text_completion JSON is returned', async () => {
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [completionsProvider()],
    });

    const response = await app.request('/v1/completions', {
      body: JSON.stringify({ model, prompt: 'hello' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const json = (await response.json()) as {
      object: string;
      id: string;
      created: number;
      model: string;
      choices: readonly [{ logprobs: unknown }];
    };

    expect(response.status).toBe(200);
    expect(json.object).toBe('text_completion');
    expect(json.id.startsWith('cmpl-')).toBe(true);
    expect(json.created).toEqual(expect.any(Number));
    expect(json.model).toEqual(expect.any(String));
    expect(json.choices[0]?.logprobs).toBe(null);
  });

  test('Given n=2 When posted Then 501s feature n without invoking the provider', async () => {
    let invoked = false;
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [
        completionsProvider(() => {
          invoked = true;
        }),
      ],
    });

    const response = await app.request('/v1/completions', {
      body: JSON.stringify({ model, prompt: 'hello', n: 2 }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(501);
    expect(body).toContain('OpenAI Completions feature is not supported: n');
    expect(body).not.toContain('prompt');
    expect(invoked).toBe(false);
  });
});
