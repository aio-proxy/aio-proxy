import { expect, test } from 'bun:test';

import type { CredentialPort, RuntimeContext, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import type { OpenRouterCredential } from '../schema/index';
import { createOpenRouterDynamicFetch, createOpenRouterRuntime } from './runtime';

test('exposes a ProviderV4 language surface and no raw resolver', async () => {
  const runtime = await createOpenRouterRuntime(runtimeContext());
  expect(runtime.provider.specificationVersion).toBe('v4');
  expect(runtime.provider.languageModel('openai/gpt-5.6-luna')).toBeDefined();
  expect(runtime.raw).toBeUndefined();
});

test('routes doGenerate through the constructed runtime and injected host fetch', async () => {
  const calls: Request[] = [];
  const controller = new AbortController();
  const runtime = await createOpenRouterRuntime({
    ...runtimeContext(),
    fetch: async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({
        id: 'gen-test',
        object: 'chat.completion',
        created: 1,
        model: 'openai/gpt-5.6-luna',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  await runtime.provider.languageModel('openai/gpt-5.6-luna').doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    abortSignal: controller.signal,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
  expect(calls[0]?.method).toBe('POST');
  expect(calls[0]?.headers.get('authorization')).toBe('Bearer sk-or-v1-test-key');
  expect(JSON.stringify([...(calls[0]?.headers ?? new Headers())])).not.toContain('dynamic-credential');
});

test('routes doEmbed through the constructed runtime and injected host fetch', async () => {
  const calls: Request[] = [];
  const runtime = await createOpenRouterRuntime({
    ...runtimeContext(),
    fetch: async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({
        object: 'list',
        model: 'google/gemini-embed',
        data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
        usage: { prompt_tokens: 2, total_tokens: 2 },
      });
    },
  });
  const result = await runtime.provider.embeddingModel('google/gemini-embed').doEmbed({
    values: ['hello'],
  });
  expect(result.embeddings).toEqual([[0.1, 0.2]]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/embeddings');
  expect(calls[0]?.method).toBe('POST');
  expect(calls[0]?.headers.get('authorization')).toBe('Bearer sk-or-v1-test-key');
  expect(JSON.stringify([...(calls[0]?.headers ?? new Headers())])).not.toContain('dynamic-credential');
});

test('routes image doGenerate through the constructed runtime and injected host fetch', async () => {
  const calls: Request[] = [];
  const runtime = await createOpenRouterRuntime({
    ...runtimeContext(),
    fetch: async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({
        data: [{ b64_json: 'Zm9v' }],
      });
    },
  });
  const result = await runtime.provider.imageModel('black-forest/flux').doGenerate({
    prompt: 'a cat',
    n: 1,
  });
  expect(result.images).toEqual(['Zm9v']);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/images');
  expect(calls[0]?.method).toBe('POST');
  expect(calls[0]?.headers.get('authorization')).toBe('Bearer sk-or-v1-test-key');
  expect(JSON.stringify([...(calls[0]?.headers ?? new Headers())])).not.toContain('dynamic-credential');
});

test('injects the durable Bearer key and preserves the abort signal', async () => {
  const inits: RuntimeRequestInit[] = [];
  const controller = new AbortController();
  const fetch = createOpenRouterDynamicFetch(staticPort(), {
    fetch: async (_input, init) => {
      inits.push(init ?? {});
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    },
  });
  await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer dynamic-credential', 'content-type': 'application/json' },
    body: '{"model":"openai/gpt-5.6-luna"}',
    signal: controller.signal,
  });
  expect(new Headers(inits[0]?.headers).get('authorization')).toBe('Bearer sk-or-v1-test-key');
  expect(inits[0]?.signal).toBe(controller.signal);
  expect(inits[0]?.aioProxy?.traffic).not.toBe('control');
});

function runtimeContext(): RuntimeContext<OpenRouterCredential, Record<string, never>> {
  return {
    credentials: staticPort(),
    options: {},
    catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
    fetch: globalThis.fetch,
  };
}

function staticPort(): CredentialPort<OpenRouterCredential> {
  return {
    read: async () => ({ revision: 1, value: { apiKey: 'sk-or-v1-test-key' } }),
    refresh: async () => {
      throw new Error('durable OpenRouter keys must not refresh');
    },
  };
}
