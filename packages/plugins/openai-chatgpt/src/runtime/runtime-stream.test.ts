import { describe, expect, test } from 'bun:test';

import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import type { CredentialPort } from '@aio-proxy/plugin-sdk';

import { createOpenAIChatGPTRuntime } from '.';
import type { ChatGPTCredential } from '../schema';

const RESPONSES_TERMINAL =
  'data: {"type":"response.completed","response":{"incomplete_details":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';

describe('OpenAI ChatGPT runtime stream protection', () => {
  test('model path finishes a zstd terminal without a late decode error', async () => {
    const { fetch, secondPulls, cancelled, acceptEncoding } = terminalThenErrorUpstream(RESPONSES_TERMINAL);
    const runtime = await runtimeWithFetch(fetch);

    const result = await runtime.provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });
    const parts = await Array.fromAsync(result.stream);

    expect(parts.some((part) => part.type === 'finish')).toBe(true);
    expect(parts.some((part) => part.type === 'error')).toBe(false);
    expect(secondPulls()).toBe(0);
    expect(cancelled()).toBe(true);
    expect(acceptEncoding()).toBe('identity');
  });

  test('a model probe succeeds when Codex rejects max_output_tokens', async () => {
    const upstreamFetch = (async (input, init) => {
      const request = new Request(input, init);
      const body = await request.json();
      if ('max_output_tokens' in body) {
        return Response.json({ detail: 'Unsupported parameter: max_output_tokens' }, { status: 400 });
      }
      return new Response(RESPONSES_TERMINAL, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof globalThis.fetch;
    const runtime = await runtimeWithFetch(upstreamFetch);
    const result = await runtime.provider.languageModel('gpt-5.6-luna').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      maxOutputTokens: 1,
    });
    const parts = await Array.fromAsync(result.stream);
    expect(parts.some((part) => part.type === 'finish')).toBe(true);
    expect(parts.some((part) => part.type === 'error')).toBe(false);
  });

  test.each(['doStream', 'doGenerate'] as const)(
    '%s propagates host sessions per invocation under concurrency without changing authentication or usage',
    async (method) => {
      const calls: { headers: Headers; body: Record<string, unknown> }[] = [];
      const fetcher = (async (input, init) => {
        const request = new Request(input, init);
        calls.push({ headers: request.headers, body: await request.json() });
        const response = {
          id: 'resp_test',
          created_at: 1,
          model: 'gpt-5.5',
          status: 'completed',
          incomplete_details: null,
          output: [],
          usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 64 }, output_tokens: 1 },
        };
        return method === 'doGenerate'
          ? Response.json(response)
          : new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, {
              headers: { 'content-type': 'text/event-stream' },
            });
      }) as typeof fetch;
      const runtime = await runtimeWithFetch(fetcher);
      const model = runtime.provider.languageModel('gpt-5.5');
      const contexts = ['a', 'b', 'a', 'c'];
      const options = contexts.map(
        (session) =>
          ({
            prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
            headers: { authorization: 'Bearer caller-token', 'x-keep': 'retained' },
            providerOptions: {
              aioProxy: {
                logicalRequest: {
                  requestId: `request-${session}`,
                  session: { key: `sha256:${session.repeat(64)}`, source: 'body-session' },
                },
              },
            },
          }) satisfies LanguageModelV4CallOptions,
      );
      await Promise.all(
        options.map(async (options) => {
          if (method === 'doGenerate') {
            const result = await model.doGenerate(options);
            expect(result.usage.inputTokens.cacheRead).toBe(64);
          } else {
            const result = await model.doStream(options);
            const parts = await Array.fromAsync(result.stream);
            expect(parts.some((part) => part.type === 'finish' && part.usage.inputTokens.cacheRead === 64)).toBe(true);
            expect(parts.some((part) => part.type === 'error')).toBe(false);
          }
        }),
      );
      expect(calls.map((call) => call.headers.get('session-id'))).toEqual(
        contexts.map((session) => `sha256:${session.repeat(64)}`),
      );
      expect(calls.every((call) => call.headers.get('authorization') === 'Bearer access-token')).toBe(true);
      expect(calls.every((call) => call.headers.get('ChatGPT-Account-Id') === 'acct-123')).toBe(true);
      expect(calls.every((call) => call.headers.get('x-keep') === 'retained')).toBe(true);
      expect(calls.every((call) => !('aioProxy' in call.body) && call.body.store === false)).toBe(true);
      expect(options.every((option) => !('session-id' in option.headers))).toBe(true);
      expect(model.specificationVersion).toBe('v4');
      expect(model.modelId).toBe('gpt-5.5');
      expect(model.provider).toBe('openai-chatgpt.responses');
      expect(await model.supportedUrls).toBeDefined();
    },
  );

  test('model calls preserve explicit headers, cache-key fallback, and anonymous isolation', async () => {
    const sessions: (string | null)[] = [];
    const fetcher = (async (input, init) => {
      sessions.push(new Request(input, init).headers.get('session-id'));
      return new Response(RESPONSES_TERMINAL, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const runtime = await runtimeWithFetch(fetcher);
    const model = runtime.provider.languageModel('gpt-5.5');
    const context = { requestId: 'request', session: { key: `sha256:${'a'.repeat(64)}`, source: 'header-session' } };
    for (const headers of [{ 'Session-Id': 'explicit' }, { session_id: 'alias' }, { 'X-Session-Id': 'alternate' }]) {
      const result = await model.doStream({
        prompt: [],
        headers,
        providerOptions: { aioProxy: { logicalRequest: context } },
      });
      await Array.fromAsync(result.stream);
    }
    const blankHeaderResult = await model.doStream({
      prompt: [],
      headers: { 'Session-Id': '', 'x-keep': 'retained' },
      providerOptions: { aioProxy: { logicalRequest: context } },
    });
    await Array.fromAsync(blankHeaderResult.stream);
    for (const logicalRequest of [
      undefined,
      null,
      [],
      {},
      { session: null },
      { session: { source: 'generated', key: context.session.key } },
      { session: { source: 'body-session', key: 'unsafe\nheader' } },
    ]) {
      const result = await model.doStream({ prompt: [], providerOptions: { aioProxy: { logicalRequest } } });
      await Array.fromAsync(result.stream);
    }
    for (let index = 0; index < 2; index++) {
      const result = await model.doStream({
        prompt: [],
        providerOptions: { openai: { promptCacheKey: 'sdk-cache-key' } },
      });
      await Array.fromAsync(result.stream);
    }
    expect(sessions.slice(0, 3)).toEqual(['explicit', 'alias', 'alternate']);
    expect(sessions[3]).toBe(context.session.key);
    expect(new Set(sessions.slice(4, 11)).size).toBe(7);
    expect(sessions[11]).toBe(sessions[12]);
  });

  test('session propagation retains model cancellation', async () => {
    const controller = new AbortController();
    const fetcher = (async (input, init) => {
      const request = new Request(input, init);
      controller.abort();
      expect(request.signal.aborted).toBe(true);
      request.signal.throwIfAborted();
      throw new Error('cancelled fetch continued');
    }) as typeof fetch;
    const runtime = await runtimeWithFetch(fetcher);
    await expect(
      runtime.provider.languageModel('gpt-5.5').doStream({
        prompt: [],
        abortSignal: controller.signal,
        providerOptions: {
          aioProxy: { logicalRequest: { session: { key: `sha256:${'a'.repeat(64)}`, source: 'body-session' } } },
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('raw path requests identity and tolerates a compressed terminal response', async () => {
    let acceptEncoding: string | null = null;
    let decompress: boolean | undefined;
    let pulls = 0;
    let wasCancelled = false;
    const plain = new TextEncoder().encode(RESPONSES_TERMINAL);
    const body = Bun.zstdCompressSync(plain);

    const upstreamFetch = (async (input, init) => {
      const request = new Request(input, init);
      acceptEncoding = request.headers.get('accept-encoding');
      decompress = (init as { decompress?: boolean } | undefined)?.decompress;
      expect(request.url).toBe('https://chatgpt.com/backend-api/codex/responses?stream=true');
      expect(request.headers.get('authorization')).toBe('Bearer runtime-token');
      expect(request.headers.get('ChatGPT-Account-Id')).toBe('acct-123');
      expect(request.headers.get('Originator')).toBe('codex-tui');
      expect(request.headers.get('session-id')).toBeString();
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls += 1;
              if (pulls === 1) {
                controller.enqueue(body);
                return;
              }
              controller.error(new TypeError('error decoding response body'));
            },
            cancel() {
              wasCancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        {
          headers: {
            'content-type': 'text/event-stream',
            'content-encoding': 'zstd',
            'content-length': String(body.byteLength),
          },
        },
      );
    }) as typeof globalThis.fetch;

    const runtime = await runtimeWithFetch(upstreamFetch, credential({ accessToken: 'runtime-token' }));
    const raw = runtime.raw?.({ protocol: 'openai-response', modelId: 'gpt-5.5' });
    expect(raw).toBeDefined();

    const response = await raw!.invoke(new Request('https://api.openai.com/v1/responses?stream=true'));
    expect(decompress).toBe(false);
    expect(acceptEncoding).toBe('identity');
    expect(await response.text()).toBe(RESPONSES_TERMINAL);
    expect(Math.max(0, pulls - 1)).toBe(0);
    expect(wasCancelled).toBe(true);
  });

  test('raw non-stream path strips client encoding and normalizes unexpected SSE once', async () => {
    let acceptEncoding: string | null = null;
    let decompress: boolean | undefined;
    const body = RESPONSES_TERMINAL;
    const upstreamFetch = (async (input, init) => {
      const request = new Request(input, init);
      acceptEncoding = request.headers.get('accept-encoding');
      decompress = (init as { decompress?: boolean } | undefined)?.decompress;
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream',
          'content-encoding': 'zstd',
          'content-length': String(body.byteLength),
        },
      });
    }) as typeof globalThis.fetch;
    const runtime = await runtimeWithFetch(upstreamFetch, credential({ accessToken: 'runtime-token' }));
    const raw = runtime.raw?.({ protocol: 'openai-response', modelId: 'gpt-5.5' });

    const response = await raw!.invoke(
      new Request('https://api.openai.com/v1/responses', { headers: { 'accept-encoding': 'br' } }),
      undefined,
      { upstreamStream: false },
    );

    expect(acceptEncoding).toBe('identity');
    expect(decompress).toBeUndefined();
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.text()).toBe(RESPONSES_TERMINAL);
  });

  // An Images stream terminates on `image_generation.*`, which the Responses SSE
  // normalizer reads as an early EOF and fails with
  // 'OpenAI Responses stream ended before a terminal event'.
  test('image path forwards a non-Responses SSE terminal untouched', async () => {
    const imageStream = 'data: {"type":"image_generation.completed","b64_json":"aGk="}\n\n';
    const upstreamFetch = (async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe('https://chatgpt.com/backend-api/codex/images/generations?stream=true');
      return new Response(imageStream, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof globalThis.fetch;

    const runtime = await runtimeWithFetch(upstreamFetch);
    const raw = runtime.raw?.({ protocol: 'openai-image', modelId: 'gpt-image-2' });

    const response = await raw!.invoke(new Request('https://api.openai.com/v1/images/generations?stream=true'));

    expect(await response.text()).toBe(imageStream);
  });
});

function terminalThenErrorUpstream(terminal: string) {
  const plain = new TextEncoder().encode(terminal);
  const body = Bun.zstdCompressSync(plain);
  let pulls = 0;
  let wasCancelled = false;

  let seenAcceptEncoding: string | null = null;
  const fetch = (async (input, init) => {
    seenAcceptEncoding = new Request(input, init).headers.get('accept-encoding');
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(body);
              return;
            }
            controller.error(new TypeError('error decoding response body'));
          },
          cancel() {
            wasCancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      {
        headers: {
          'content-type': 'text/event-stream',
          'content-encoding': 'zstd',
        },
      },
    );
  }) as typeof globalThis.fetch;

  return {
    fetch,
    secondPulls: () => Math.max(0, pulls - 1),
    cancelled: () => wasCancelled,
    acceptEncoding: () => seenAcceptEncoding,
  };
}

function credential(overrides: Partial<ChatGPTCredential> = {}): ChatGPTCredential {
  return {
    accessToken: 'access-token',
    accountId: 'acct-123',
    expiresAt: Date.now() + 60_000,
    refreshToken: 'refresh-token',
    ...overrides,
  };
}

function staticCredentialPort(value: ChatGPTCredential): CredentialPort<ChatGPTCredential> {
  return {
    read: async () => ({ revision: 1, value }),
    refresh: async () => {
      throw new Error('valid credentials must not refresh');
    },
  };
}

async function runtimeWithFetch(fetcher: typeof fetch, value = credential()) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    return await createOpenAIChatGPTRuntime({
      credentials: staticCredentialPort(value),
      options: {},
      catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}
