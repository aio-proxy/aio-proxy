import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ApiProviderInstance, TextStreamPart, ToolSet } from '@aio-proxy/core';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { createServer } from '#server-test-lifecycle';

import type { RuntimeProviderInstance } from '../src/runtime';
import { recorded } from './trace-recording.test-support';

const protocols = [
  ProviderProtocol.OpenAICompatible,
  ProviderProtocol.OpenAIResponse,
  ProviderProtocol.Anthropic,
  ProviderProtocol.Gemini,
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

type InboundCase = (typeof inboundCases)[number];
type Calls = { model: number; raw: number };

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

async function request(inbound: InboundCase, providers: readonly RuntimeProviderInstance[], dbHome?: string) {
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

async function requestPath(
  path: string,
  body: unknown,
  providers: readonly RuntimeProviderInstance[],
  method: string = 'POST',
) {
  const app = await createServer({
    config: { providers: {} },
    dbHome: tempHome(),
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
  } as const;
  expect(body).toMatchObject(shapes[protocol]);
}
