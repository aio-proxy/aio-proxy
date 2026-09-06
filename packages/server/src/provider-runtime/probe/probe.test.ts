import { expect, test } from 'bun:test';

import { createApiProvider } from '@aio-proxy/core';
import type { Provider } from '@aio-proxy/types';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { probeApi, providerProbeRequest } from '.';

test.each([
  { expected: 'OK', status: 200 },
  { expected: 'FAIL', status: 502 },
] as const)('uses non-stream transport for a $status probe response', async ({ expected, status }) => {
  let cancelled = false;
  let decompression: boolean | undefined;
  let acceptEncoding: string | null;
  const provider = {
    baseURL: 'https://upstream.test',
    enabled: true,
    id: 'probe',
    kind: ProviderKind.Api,
    models: ['gpt-probe'],
    protocol: ProviderProtocol.OpenAIResponse,
  } as const;
  const instance = createApiProvider(provider, {
    fetch: (async (_input, init) => {
      decompression = (init as { readonly decompress?: boolean } | undefined)?.decompress;
      acceptEncoding = new Headers(init?.headers).get('accept-encoding');
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status },
      );
    }) as typeof globalThis.fetch,
  });

  expect(await probeApi(provider, instance)).toBe(expected);
  expect(cancelled).toBeTrue();
  expect(decompression).toBeUndefined();
  expect(acceptEncoding).toBeNull();
});

test('probe sends the standard inbound path through the primary endpoint transport', async () => {
  let requested: string | undefined;
  const provider = {
    apiKey: 'k',
    baseURL: 'https://api.z.ai/api/paas/v4',
    enabled: true,
    id: 'zai',
    kind: ProviderKind.Api,
    models: ['glm-4.7'],
    protocol: ProviderProtocol.OpenAICompatible,
  } as const;
  const instance = createApiProvider(provider, {
    fetch: (async (input: string | URL | Request) => {
      requested = input instanceof Request ? input.url : String(input);
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch,
  });

  expect(await probeApi(provider, instance)).toBe('OK');
  // origin 模式冻结现状：探测打到 origin + 标准路径，端点 transport 是唯一改写 URL 的地方。
  expect(requested).toBe('https://api.z.ai/v1/chat/completions');
});

test('probe follows sdk base URL semantics for an endpoints-only provider', async () => {
  let requested: string | undefined;
  let apiKeyHeader: string | null = null;
  const provider = {
    apiKey: 'k',
    enabled: true,
    endpoints: [{ protocol: ProviderProtocol.Gemini, baseURL: 'https://g.example.com/v1beta' }],
    id: 'gemini-gateway',
    kind: ProviderKind.Api,
    models: ['gemini-pro'],
  } satisfies Provider;
  const instance = createApiProvider(provider, {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requested = input instanceof Request ? input.url : String(input);
      apiKeyHeader = new Headers(init?.headers).get('x-goog-api-key');
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch,
  });

  expect(await probeApi(provider, instance)).toBe('OK');
  expect(requested).toBe('https://g.example.com/v1beta/models/gemini-pro:generateContent');
  expect(apiKeyHeader).toBe('k');
});

test('probe of a primary gemini-interactions endpoint posts store:false ping', async () => {
  let requested: string | undefined;
  let body: unknown;
  const provider = {
    apiKey: 'k',
    enabled: true,
    endpoints: [{ protocol: ProviderProtocol.GeminiInteractions, baseURL: 'https://g.example.com/v1beta' }],
    id: 'interactions-gateway',
    kind: ProviderKind.Api,
    models: ['gemini-3.5-flash'],
  } satisfies Provider;
  const instance = createApiProvider(provider, {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requested = input instanceof Request ? input.url : String(input);
      body = JSON.parse(await new Response(init?.body).text());
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch,
  });

  expect(await probeApi(provider, instance)).toBe('OK');
  expect(requested).toBe('https://g.example.com/v1beta/interactions');
  expect(body).toEqual({ model: 'gemini-3.5-flash', input: 'ping', store: false });
  expect(body).not.toHaveProperty('agent');
});

test('a model test probe waits ten seconds, not one', async () => {
  let timeoutMs: number | undefined;
  const original = AbortSignal.timeout;
  AbortSignal.timeout = ((ms: number) => {
    timeoutMs = ms;
    return original(ms);
  }) as typeof AbortSignal.timeout;
  const provider = {
    apiKey: 'k',
    enabled: true,
    endpoints: { baseURL: 'https://gw.example/v1', protocol: [ProviderProtocol.OpenAICompatible] },
    id: 'slow-gateway',
    kind: ProviderKind.Api,
    models: ['slow-model'],
  } satisfies Provider;
  try {
    const instance = createApiProvider(provider, {
      fetch: (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch,
    });
    expect(await probeApi(provider, instance)).toBe('OK');
    expect(timeoutMs).toBe(10_000);
  } finally {
    AbortSignal.timeout = original;
  }
});

test('image-primary probe posts a generations ping through the primary transport', async () => {
  let requested: string | undefined;
  let method: string | undefined;
  let contentType: string | null = null;
  let body: unknown;
  const provider = {
    apiKey: 'k',
    baseURL: 'https://api.openai.com/v1',
    enabled: true,
    id: 'images',
    kind: ProviderKind.Api,
    models: ['gpt-image-2'],
    protocol: ProviderProtocol.OpenAIImage,
  } as const;
  expect(providerProbeRequest(provider, 'gpt-image-2')).toEqual({
    body: { model: 'gpt-image-2', n: 1, prompt: 'ping' },
    path: '/v1/images/generations',
  });
  const instance = createApiProvider(provider, {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requested = input instanceof Request ? input.url : String(input);
      method = init?.method;
      contentType = new Headers(init?.headers).get('content-type');
      body = JSON.parse(await new Response(init?.body).text());
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch,
  });

  expect(await probeApi(provider, instance)).toBe('OK');
  expect(requested).toBe('https://api.openai.com/v1/images/generations');
  // 音频探测引入 method 后的护栏：既有协议的方法、body 与 content-type 必须逐字不变。
  expect(method).toBe('POST');
  expect(contentType).toBe('application/json');
  expect(body).toEqual({ model: 'gpt-image-2', n: 1, prompt: 'ping' });
});

test('transcription-only audio provider probes GET /v1/models with no body', async () => {
  let requested: string | undefined;
  let method: string | undefined;
  let contentType: string | null = null;
  let authorization: string | null = null;
  let body: unknown;
  const provider = {
    apiKey: 'k',
    enabled: true,
    endpoints: [{ protocol: ProviderProtocol.OpenAIAudio, baseURL: 'https://audio.example.com/v1' }],
    id: 'whisper-gateway',
    kind: ProviderKind.Api,
    models: ['whisper-1'],
  } satisfies Provider;
  const instance = createApiProvider(provider, {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requested = input instanceof Request ? input.url : String(input);
      method = init?.method;
      contentType = new Headers(init?.headers).get('content-type');
      authorization = new Headers(init?.headers).get('authorization');
      body = init?.body ?? undefined;
      return new Response('{"data":[]}', { status: 200 });
    }) as typeof globalThis.fetch,
  });

  expect(await probeApi(provider, instance)).toBe('OK');
  expect(method).toBe('GET');
  // sdk 模式下 '/v1' 前缀被剥掉再拼到 baseURL path 之后，与其他协议的探测路径同规则。
  expect(requested).toBe('https://audio.example.com/v1/models');
  expect(body).toBeUndefined();
  expect(contentType).toBeNull();
  // 探测的意义在于验证凭据，所以 GET 分支也必须注入 api key。
  expect(authorization).toBe('Bearer k');
});

test('audio provider that rejects the api key probes FAIL', async () => {
  const provider = {
    apiKey: 'wrong',
    baseURL: 'https://audio.example.com/v1',
    enabled: true,
    id: 'audio-401',
    kind: ProviderKind.Api,
    models: ['whisper-1'],
    protocol: ProviderProtocol.OpenAIAudio,
  } as const;
  const instance = createApiProvider(provider, {
    fetch: (async () => new Response('{"error":{}}', { status: 401 })) as typeof globalThis.fetch,
  });

  // 上游若把 /v1/models 设为免鉴权，错误密钥仍会得到 200 而误报 OK；
  // 这条只保证鉴权确实被执行时红灯不会丢。
  expect(await probeApi(provider, instance)).toBe('FAIL');
});

test('speech audio provider probes the same capability-agnostic endpoint', async () => {
  let requested: string | undefined;
  let method: string | undefined;
  const provider = {
    apiKey: 'k',
    baseURL: 'https://tts.example.com/v1',
    enabled: true,
    id: 'tts',
    kind: ProviderKind.Api,
    models: ['tts-1'],
    protocol: ProviderProtocol.OpenAIAudio,
  } as const;
  // 探测请求不含 model：语音与转写模型共用同一个连通性检查。
  expect(providerProbeRequest(provider, 'tts-1')).toEqual({ method: 'GET', path: '/v1/models' });
  const instance = createApiProvider(provider, {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requested = input instanceof Request ? input.url : String(input);
      method = init?.method;
      return new Response('{"data":[]}', { status: 200 });
    }) as typeof globalThis.fetch,
  });

  expect(await probeApi(provider, instance)).toBe('OK');
  expect(method).toBe('GET');
  expect(requested).toBe('https://tts.example.com/v1/models');
});
