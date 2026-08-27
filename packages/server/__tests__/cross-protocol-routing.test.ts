import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ApiProviderInstance, TextStreamPart, ToolSet } from '@aio-proxy/core';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { createServer } from '#server-test-lifecycle';

import type {
  ImageTransport,
  ImageTransportInvokeRequest,
  ModelCapabilityIndex,
  RuntimeProviderInstance,
} from '../src/runtime';
import { recorded } from './trace-recording.test-support';

const protocols = [
  ProviderProtocol.OpenAICompatible,
  ProviderProtocol.OpenAIResponse,
  ProviderProtocol.Anthropic,
  ProviderProtocol.Gemini,
  ProviderProtocol.GeminiInteractions,
] as const;

const inboundCases = [
  {
    protocol: ProviderProtocol.OpenAICompatible,
    path: '/v1/chat/completions',
    body: { model: 'm', messages: [{ role: 'user', content: 'hello' }] },
  },
  {
    protocol: ProviderProtocol.OpenAIResponse,
    path: '/v1/responses',
    body: { model: 'm', input: 'hello' },
  },
  {
    protocol: ProviderProtocol.Anthropic,
    path: '/v1/messages',
    body: { model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] },
  },
  {
    protocol: ProviderProtocol.Gemini,
    path: '/v1beta/models/m:generateContent',
    body: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
  },
  {
    protocol: ProviderProtocol.GeminiInteractions,
    path: '/v1beta/interactions',
    body: { model: 'm', input: 'hello', store: false },
  },
] as const;

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
});

describe('cross-protocol HTTP routing', () => {
  test.each([
    [ProviderProtocol.Gemini, 'same protocol', 'raw'],
    [ProviderProtocol.OpenAIResponse, 'cross protocol', 'model'],
    [ProviderProtocol.OpenAICompatible, 'cross protocol', 'model'],
    [ProviderProtocol.Anthropic, 'cross protocol', 'model'],
    [ProviderProtocol.Gemini, 'raw unavailable', 'model'],
  ] as const)('routes Antigravity %s %s through %s', async (protocol, condition, expectedCapability) => {
    expect(await runAntigravityMatrixCase(protocol, condition)).toBe(expectedCapability);
  });

  for (const inbound of inboundCases) {
    for (const providerProtocol of protocols) {
      test(`${inbound.protocol} inbound uses ${providerProtocol} raw only when protocols match`, async () => {
        const fixture = provider(providerProtocol, 'only');
        const response = await request(inbound, [fixture.value]);

        expect(response.status).toBe(200);
        expect(fixture.calls).toEqual({
          model: inbound.protocol === providerProtocol ? 0 : 1,
          raw: inbound.protocol === providerProtocol ? 1 : 0,
        });
        if (inbound.protocol !== providerProtocol) {
          expectModelResponse(inbound.protocol, await response.json(), `model:${providerProtocol}`);
        }
      });
    }
  }

  test('Antigravity still raw-resolves only gemini; Interactions inbound converts', async () => {
    expect(await runAntigravityMatrixCase(ProviderProtocol.GeminiInteractions, 'cross protocol')).toBe('model');
  });

  test('omitted store 501s on language-only then raws a later Interactions candidate', async () => {
    const language = provider(ProviderProtocol.Gemini, 'language');
    const native = provider(ProviderProtocol.GeminiInteractions, 'native');
    const response = await request(
      {
        protocol: ProviderProtocol.GeminiInteractions,
        path: '/v1beta/interactions',
        body: { model: 'm', input: 'hello' },
      },
      [language.value, native.value],
    );
    expect(await response.text()).toBe(`raw:${ProviderProtocol.GeminiInteractions}`);
    expect(language.calls).toEqual({ model: 0, raw: 0 });
    expect(native.calls).toEqual({ model: 0, raw: 1 });
  });

  test('agent inbound 501s on language-only and raws Interactions including alias rewrite', async () => {
    const language = provider(ProviderProtocol.OpenAICompatible, 'language');
    const native = provider(ProviderProtocol.GeminiInteractions, 'native');
    const response = await request(
      {
        protocol: ProviderProtocol.GeminiInteractions,
        path: '/v1beta/interactions',
        body: { agent: 'm', input: 'hello' },
      },
      [language.value, native.value],
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`raw:${ProviderProtocol.GeminiInteractions}`);
    expect(language.calls).toEqual({ model: 0, raw: 0 });
    expect(native.calls).toEqual({ model: 0, raw: 1 });
  });

  test('Completions inbound uses openai-compatible raw only when protocols match', async () => {
    const same = provider(ProviderProtocol.OpenAICompatible, 'same');
    const response = await requestPath('/v1/completions', { model: 'm', prompt: 'hello' }, [same.value]);
    expect(response.status).toBe(200);
    expect(same.calls).toEqual({ model: 0, raw: 1 });
  });

  test('Completions inbound cross-protocol emits text_completion identity fields', async () => {
    const other = provider(ProviderProtocol.OpenAIResponse, 'other');
    const response = await requestPath('/v1/completions', { model: 'm', prompt: 'hello' }, [other.value]);
    expect(response.status).toBe(200);
    expect(other.calls).toEqual({ model: 1, raw: 0 });
    expect(await response.json()).toMatchObject({
      object: 'text_completion',
      model: expect.any(String),
      created: expect.any(Number),
      choices: [{ index: 0, logprobs: null }],
    });
  });

  test('Completions unfaithful n=2 501s model-only and still raw-forwards later', async () => {
    const modelOnly = provider(ProviderProtocol.OpenAIResponse, 'model-only');
    const rawLater = provider(ProviderProtocol.OpenAICompatible, 'raw-later');
    const body = { model: 'm', prompt: 'hello', n: 2 };
    const blocked = await requestPath('/v1/completions', body, [modelOnly.value]);
    expect(blocked.status).toBe(501);
    expect(modelOnly.calls.raw).toBe(0);
    const forwarded = await requestPath('/v1/completions', body, [modelOnly.value, rawLater.value]);
    expect(forwarded.status).toBe(200);
    expect(rawLater.calls).toEqual({ model: 0, raw: 1 });
  });

  test('compact same-protocol raw is unary JSON and omitted input still 200s', async () => {
    let upstreamStream: boolean | undefined;
    const fixture = provider(ProviderProtocol.OpenAIResponse, 'compact-raw');
    fixture.value.raw = {
      resolve: ({ protocol }) =>
        protocol === ProviderProtocol.OpenAIResponse
          ? {
              invoke: async (_req, _ctx, options) => {
                upstreamStream = options?.upstreamStream;
                fixture.calls.raw += 1;
                return Response.json({ object: 'response.compaction', output: [] });
              },
            }
          : undefined,
    };
    const response = await requestPath('/v1/responses/compact', { model: 'm' }, [fixture.value]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ object: 'response.compaction' });
    expect(upstreamStream).toBe(false);
    expect(fixture.calls).toEqual({ model: 0, raw: 1 });
  });

  test.each([ProviderProtocol.OpenAICompatible, ProviderProtocol.Anthropic, ProviderProtocol.Gemini] as const)(
    'compact %s is 501 responses_compact and does not model-invoke',
    async (protocol) => {
      const fixture = provider(protocol, 'other');
      const response = await requestPath('/v1/responses/compact', { model: 'm', input: null }, [fixture.value]);
      expect(response.status).toBe(501);
      expect(JSON.stringify(await response.json())).toContain('responses_compact');
      expect(fixture.calls).toEqual({ model: 0, raw: 0 });
    },
  );

  test('falls back from model preflight failure to matching raw and stops', async () => {
    const first = provider(ProviderProtocol.Anthropic, 'first', {
      model: () => new ReadableStream({ start: (controller) => controller.error(new Error('model unavailable')) }),
    });
    const second = provider(ProviderProtocol.OpenAICompatible, 'second');
    const third = provider(ProviderProtocol.OpenAICompatible, 'third');
    const home = tempHome();
    const response = await request(inboundCases[0], [first.value, second.value, third.value], home);

    expect(await response.text()).toBe(`raw:${ProviderProtocol.OpenAICompatible}`);
    expect(first.calls).toEqual({ model: 1, raw: 0 });
    expect(second.calls).toEqual({ model: 0, raw: 1 });
    expect(third.calls).toEqual({ model: 0, raw: 0 });
    expect(await recordedAttempts(home)).toEqual([
      expect.objectContaining({ outcome: 'failure', providerId: 'first' }),
      expect.objectContaining({ outcome: 'success', providerId: 'second' }),
    ]);
  });

  test('falls back on proxy failure without direct retry of the failed Provider ID', async () => {
    // Bun may bypass proxy for literal 127.0.0.1; localtest.me still binds locally.
    let firstHits = 0;
    let secondHits = 0;
    const serve = (onHit: () => number, body: Response) =>
      Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => (onHit(), body) });
    const firstUpstream = serve(() => (firstHits += 1), Response.json({ error: 'unreachable' }, { status: 500 }));
    const secondUpstream = serve(
      () => (secondHits += 1),
      Response.json({ choices: [{ message: { role: 'assistant', content: 'fallback ok' } }] }),
    );
    const reserved = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const deadProxy = `http://proxy-user:proxy-pass-secret@127.0.0.1:${reserved.port}`;
    await reserved.stop(true);
    const headerSecret = 'hdr-secret-proxy-fallback';
    const home = tempHome();
    const api = (baseURL: string, weight: number, proxy: string | false) => ({
      kind: 'api' as const,
      protocol: ProviderProtocol.OpenAICompatible,
      baseURL,
      models: ['m'],
      weight,
      proxy,
      ...(typeof proxy === 'string' ? { headers: { 'X-Secret': headerSecret } } : {}),
    });
    try {
      const app = await createServer({
        config: {
          providers: {
            proxied: api(`http://localtest.me:${firstUpstream.port}`, 10, deadProxy),
            direct: api(`http://127.0.0.1:${secondUpstream.port}`, 1, false),
          },
        },
        dbHome: home,
      });
      const response = await app.request('/v1/chat/completions', {
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hello' }] }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain('fallback ok');
      expect([firstHits, secondHits]).toEqual([0, 1]);
      const attempts = await recordedAttempts(home);
      expect(attempts).toEqual([
        expect.objectContaining({ outcome: 'failure', providerId: 'proxied' }),
        expect.objectContaining({ outcome: 'success', providerId: 'direct' }),
      ]);
      const diagnostic = JSON.stringify({ attempts, body });
      for (const secret of [headerSecret, 'proxy-pass-secret', deadProxy]) expect(diagnostic).not.toContain(secret);
    } finally {
      await Promise.all([firstUpstream.stop(true), secondUpstream.stop(true)]);
    }
  });
});

const IMAGES_PATH = '/v1/images/generations';
const IMAGES_NOT_IMPLEMENTED = 'No configured provider can generate images for this model';
const IMAGE_METADATA = { capabilities: { modalities: { output: ['image'] as const } } };

describe('openai-image inbound', () => {
  test('image-only catalog.image id is 200 on Images and not 404', async () => {
    const fixture = imageConvertProvider('catalog', 'gpt-image-2', { capabilities: ['image'] });
    const response = await requestImages({ model: 'gpt-image-2', prompt: 'a cat' }, [fixture.value]);

    expect(response.status).toBe(200);
    expect(response.status).not.toBe(404);
    expect(fixture.calls.image).toBe(1);
    expect(await response.json()).toMatchObject({ data: [{ b64_json: expect.any(String) }] });
  });

  test('image-only catalog id is filtered from chat completions and does not invoke image', async () => {
    const fixture = imageConvertProvider('catalog', 'gpt-image-2', { capabilities: ['image'] });
    const app = await createServer({
      config: { providers: {} },
      dbHome: tempHome(),
      providerInstances: [fixture.value],
    });
    const response = await app.request('/v1/chat/completions', {
      body: JSON.stringify({ model: 'gpt-image-2', messages: [{ role: 'user', content: 'hello' }] }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect([404, 501]).toContain(response.status);
    expect(response.status).not.toBe(200);
    expect(fixture.calls.image).toBe(0);
  });

  test('dummy V4 imageModel with language-only catalog is skipped and does not invoke', async () => {
    const fixture = imageConvertProvider('dummy', 'gpt-5', { capabilities: ['language'] });
    const response = await requestImages({ model: 'gpt-5', prompt: 'a cat' }, [fixture.value]);

    expect(response.status).toBe(501);
    expect(fixture.calls.image).toBe(0);
  });

  test('documented example routes omitted-model generations to gpt-image-2', async () => {
    const fixture = documentedImageProvider(['gpt-image-2', 'dall-e-2', 'gpt-image-1.5']);
    const response = await requestImages({ prompt: 'a cat' }, [fixture.value]);

    expect(response.status).toBe(200);
    expect(fixture.calls.raw).toBe(1);
    expect(fixture.rawBodies[0]).toMatchObject({ model: 'gpt-image-2', prompt: 'a cat' });
  });

  test('same documented provider without gpt-image-2 404s the CPA default', async () => {
    const fixture = documentedImageProvider(['dall-e-2', 'gpt-image-1.5']);
    const response = await requestImages({ prompt: 'a cat' }, [fixture.value]);

    expect(response.status).toBe(404);
    expect(fixture.calls.raw).toBe(0);
  });

  test('sibling gpt-5 in models is not image-capable unless metadata says so', async () => {
    const fixture = documentedImageProvider(['gpt-5', 'gpt-image-2'], {
      metadataIds: ['gpt-image-2'],
    });

    const sibling = await requestImages({ model: 'gpt-5', prompt: 'a cat' }, [fixture.value]);
    const image = await requestImages({ model: 'gpt-image-2', prompt: 'a cat' }, [fixture.value]);

    expect(sibling.status).toBe(501);
    expect(image.status).toBe(200);
    expect(fixture.calls.raw).toBe(1);
    expect(fixture.rawBodies[0]).toMatchObject({ model: 'gpt-image-2' });
  });

  test('non-catalog openai-image endpoint without finite ids does not wildcard-route', async () => {
    const fixture = documentedImageProvider([]);
    const omitted = await requestImages({ prompt: 'a cat' }, [fixture.value]);
    const explicit = await requestImages({ model: 'gpt-image-2', prompt: 'a cat' }, [fixture.value]);

    expect(omitted.status).toBe(404);
    expect(explicit.status).toBe(404);
    expect(fixture.calls.raw).toBe(0);
  });

  test('same-protocol openai-image uses raw and chat-protocol providers do not raw-receive Images', async () => {
    const images = documentedImageProvider(['gpt-image-2']);
    const chat = provider(ProviderProtocol.OpenAICompatible, 'chat');
    const response = await requestImages({ model: 'gpt-image-2', prompt: 'a cat' }, [images.value, chat.value]);

    expect(response.status).toBe(200);
    expect(images.calls.raw).toBe(1);
    expect(chat.calls.raw).toBe(0);
    expect(chat.calls.model).toBe(0);
  });

  test('all-filtered eligible set returns 501 images not-found message, not 404', async () => {
    const languageOnly = provider(ProviderProtocol.OpenAICompatible, 'chat');
    const response = await requestImages({ model: 'm', prompt: 'a cat' }, [languageOnly.value]);
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(response.status).not.toBe(404);
    expect(body).toMatchObject({
      error: { code: 'not_implemented', message: IMAGES_NOT_IMPLEMENTED },
    });
  });

  test('usage records imageCount', async () => {
    const home = tempHome();
    const fixture = imageConvertProvider('convert', 'gpt-image-2', {
      capabilities: ['image'],
      images: [new Uint8Array([1]), new Uint8Array([2])],
    });
    const response = await requestImages({ model: 'gpt-image-2', prompt: 'a cat' }, [fixture.value], home);
    const body = (await response.json()) as { data?: readonly unknown[] };

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(fixture.calls.image).toBe(1);
    const { requests } = await recorded(home);
    expect(requests[0]).toMatchObject({
      inboundProtocol: 'openai-image',
      outcome: 'success',
      finalProviderId: 'convert',
      finalModelId: 'gpt-image-2',
    });
  });

  test('POST /v1/images/variations stays 404', async () => {
    const fixture = documentedImageProvider(['gpt-image-2']);
    const app = await createServer({
      config: { providers: {} },
      dbHome: tempHome(),
      providerInstances: [fixture.value],
    });
    const response = await app.request('/v1/images/variations', {
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a cat' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(404);
    expect(fixture.calls.raw).toBe(0);
  });

  test('language inbound does not call image convert', async () => {
    const imageCalls: ImageTransportInvokeRequest[] = [];
    const fixture = provider(ProviderProtocol.Anthropic, 'cross');
    const response = await request(inboundCases[0], [
      {
        ...fixture.value,
        image: {
          async invoke(request: ImageTransportInvokeRequest) {
            imageCalls.push(request);
            return { images: [new Uint8Array([1])] };
          },
        },
      },
    ]);

    expect(response.status).toBe(200);
    expect(imageCalls).toHaveLength(0);
    expect(fixture.calls.model).toBe(1);
  });
});

type Calls = { model: number; raw: number };
type ImageCalls = { image: number; raw: number };

function imageConvertProvider(
  id: string,
  modelId: string,
  options: {
    readonly capabilities: readonly ('image' | 'language')[];
    readonly images?: readonly Uint8Array[];
  },
): { readonly calls: ImageCalls; readonly value: RuntimeProviderInstance } {
  const calls: ImageCalls = { image: 0, raw: 0 };
  const invoke: ImageTransport['invoke'] = async () => {
    calls.image += 1;
    return { images: options.images ?? [new Uint8Array([1, 2, 3])] };
  };
  return {
    calls,
    value: {
      capabilityIndex: { [modelId]: new Set(options.capabilities) },
      enabled: true,
      id,
      image: { invoke },
      kind: ProviderKind.AiSdk,
      models: [modelId],
    } satisfies RuntimeProviderInstance,
  };
}

function documentedImageProvider(
  models: readonly string[],
  options: { readonly metadataIds?: readonly string[] } = {},
): {
  readonly calls: ImageCalls;
  readonly rawBodies: unknown[];
  readonly value: RuntimeProviderInstance;
} {
  const calls: ImageCalls = { image: 0, raw: 0 };
  const rawBodies: unknown[] = [];
  const metadataIds = options.metadataIds ?? models;
  const raw = async (request: Request) => {
    calls.raw += 1;
    rawBodies.push(await request.clone().json());
    return Response.json({ created: 1, data: [{ b64_json: 'YQ==' }] });
  };
  const capabilityIndex: ModelCapabilityIndex = Object.fromEntries(
    models.map((modelId) => [
      modelId,
      new Set(metadataIds.includes(modelId) ? (['image'] as const) : (['language'] as const)),
    ]),
  );
  return {
    calls,
    rawBodies,
    value: {
      capabilityIndex,
      configMetadata: Object.fromEntries(metadataIds.map((modelId) => [modelId, IMAGE_METADATA])),
      enabled: true,
      endpointTransports: [{ protocol: ProviderProtocol.OpenAIImage, passthrough: raw }],
      id: 'openai',
      kind: ProviderKind.Api,
      models,
      protocol: ProviderProtocol.OpenAIResponse,
      raw: {
        resolve: ({ protocol }) => (protocol === ProviderProtocol.OpenAIImage ? { invoke: raw } : undefined),
      },
    } satisfies ApiProviderInstance & RuntimeProviderInstance,
  };
}

async function runAntigravityMatrixCase(
  protocol: ProviderProtocol,
  condition: 'same protocol' | 'cross protocol' | 'raw unavailable',
): Promise<'model' | 'raw'> {
  const inbound = inboundCases.find((candidate) => candidate.protocol === protocol);
  if (inbound === undefined) throw new Error(`Missing inbound fixture for ${protocol}`);
  const fixture = antigravityProvider(condition !== 'raw unavailable');
  const response = await request(inbound, [fixture.value]);

  expect(response.status).toBe(200);
  if (fixture.calls.raw === 1) {
    expect(await response.text()).toBe('raw:antigravity');
    return 'raw';
  }
  expectModelResponse(protocol, await response.json(), 'model:antigravity');
  return 'model';
}

function antigravityProvider(rawAvailable: boolean): {
  readonly calls: Calls;
  readonly value: RuntimeProviderInstance;
} {
  const calls: Calls = { model: 0, raw: 0 };
  return {
    calls,
    value: {
      alias: { m: { model: 'm', preserve: false } },
      capability: 'default',
      capabilityIndex: { m: new Set(['language']) },
      enabled: true,
      id: 'antigravity',
      kind: ProviderKind.OAuth,
      model: { invoke: () => ((calls.model += 1), modelStream('model:antigravity')) },
      models: ['m'],
      plugin: '@aio-proxy/plugin-google-antigravity',
      raw: {
        resolve: ({ protocol }: { readonly protocol: ProviderProtocol }) =>
          rawAvailable && protocol === ProviderProtocol.Gemini
            ? { invoke: async () => ((calls.raw += 1), new Response('raw:antigravity')) }
            : undefined,
      },
    } satisfies RuntimeProviderInstance,
  };
}

function provider(
  protocol: ProviderProtocol,
  id: string,
  options: { readonly model?: () => ReadableStream<TextStreamPart<ToolSet>> } = {},
): { readonly calls: Calls; readonly value: RuntimeProviderInstance } {
  const calls: Calls = { model: 0, raw: 0 };
  const raw = async () => ((calls.raw += 1), new Response(`raw:${protocol}`));
  const invoke = () => ((calls.model += 1), options.model?.() ?? modelStream(`model:${protocol}`));
  return {
    calls,
    value: {
      alias: { m: { model: 'm', preserve: false } },
      baseURL: `https://${id}.example.test`,
      capabilityIndex: { m: new Set(['language']) },
      enabled: true,
      endpointTransports: [{ protocol, passthrough: raw }],
      id,
      kind: ProviderKind.Api,
      model: { invoke },
      models: ['m'],
      passthrough: raw,
      protocol,
      raw: { resolve: ({ protocol: inbound }) => (inbound === protocol ? { invoke: raw } : undefined) },
    } satisfies ApiProviderInstance & RuntimeProviderInstance,
  };
}

function modelStream(text: string): ReadableStream<TextStreamPart<ToolSet>> {
  const empty = { cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 0 };
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'text-delta', id: 'text-1', text });
      controller.enqueue({
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'stop',
        totalUsage: {
          inputTokenDetails: empty,
          inputTokens: 0,
          outputTokenDetails: { reasoningTokens: 0, textTokens: 0 },
          outputTokens: 0,
          totalTokens: 0,
        },
      });
      controller.close();
    },
  });
}

async function request(
  inbound: { protocol: ProviderProtocol; path: string; body: unknown },
  providers: readonly RuntimeProviderInstance[],
  dbHome?: string,
) {
  const app = await createServer({
    config: { providers: {} },
    dbHome: dbHome ?? tempHome(),
    providerInstances: providers,
  });
  return app.request(inbound.path, {
    body: JSON.stringify(inbound.body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

async function requestImages(
  body: Record<string, unknown>,
  providers: readonly RuntimeProviderInstance[],
  dbHome?: string,
) {
  return requestPath(IMAGES_PATH, body, providers, 'POST', dbHome);
}

async function requestPath(
  path: string,
  body: unknown,
  providers: readonly RuntimeProviderInstance[],
  method: string = 'POST',
  dbHome?: string,
) {
  const app = await createServer({
    config: { providers: {} },
    dbHome: dbHome ?? tempHome(),
    providerInstances: providers,
  });
  return app.request(path, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method,
  });
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-cross-protocol-'));
  homes.push(home);
  return home;
}

async function recordedAttempts(home: string) {
  const { requests } = await recorded(home);
  return requests[0]?.attempts ?? [];
}

function expectModelResponse(protocol: ProviderProtocol, body: unknown, text: string): void {
  const shapes = {
    [ProviderProtocol.OpenAICompatible]: { choices: [{ message: { role: 'assistant', content: text } }] },
    [ProviderProtocol.OpenAIResponse]: {
      object: 'response',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    },
    [ProviderProtocol.Anthropic]: { type: 'message', role: 'assistant', content: [{ type: 'text', text }] },
    [ProviderProtocol.Gemini]: { candidates: [{ content: { role: 'model', parts: [{ text }] } }] },
    [ProviderProtocol.GeminiInteractions]: {
      object: 'interaction',
      steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
      usage: { total_input_tokens: 0 },
    },
  } as const;
  expect(body).toMatchObject(shapes[protocol]);
}
