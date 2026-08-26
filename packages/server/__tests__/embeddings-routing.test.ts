import { describe, expect, test } from 'bun:test';

import type { EmbeddingResult, TextStreamPart, ToolSet } from '@aio-proxy/core';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { createServer, createServerTestHome } from '#server-test-lifecycle';

import type { RuntimeProviderInstance } from '../src/runtime';
import { recorded } from './trace-recording.test-support';

const OPENAI_EMBEDDINGS = {
  path: '/v1/embeddings',
  body: { model: 'm', input: 'hello' },
} as const;

const GEMINI_EMBED = {
  path: '/v1beta/models/m:embedContent',
  body: { content: { parts: [{ text: 'hello' }] } },
} as const;

const GEMINI_BATCH_EMBED = {
  path: '/v1beta/models/m:batchEmbedContents',
  body: { requests: [{ content: { parts: [{ text: 'one' }] } }, { content: { parts: [{ text: 'two' }] } }] },
} as const;

describe('embeddings HTTP dispatch matrix', () => {
  test('OpenAI embeddings uses same-protocol openai-compatible raw, not language invoke', async () => {
    const fixture = provider(ProviderProtocol.OpenAICompatible, 'compatible');
    const response = await request(OPENAI_EMBEDDINGS, [fixture.value]);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('raw:openai-compatible');
    expect(fixture.calls).toEqual({ model: 0, raw: 1, embed: 0 });
  });

  test('OpenAI embeddings converts through a gemini-raw-only candidate', async () => {
    const fixture = provider(ProviderProtocol.Gemini, 'gemini', { embedding: true });
    const response = await request(OPENAI_EMBEDDINGS, [fixture.value]);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      object: 'list',
      model: 'm',
      usage: { prompt_tokens: 3, total_tokens: 3 },
    });
    expect(fixture.calls).toEqual({ model: 0, raw: 0, embed: 1 });
  });

  test('OpenAI embeddings converts through openai-response instead of raw', async () => {
    const fixture = provider(ProviderProtocol.OpenAIResponse, 'responses', { embedding: true });
    const response = await request(OPENAI_EMBEDDINGS, [fixture.value]);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ object: 'list', model: 'm' });
    expect(fixture.calls).toEqual({ model: 0, raw: 0, embed: 1 });
  });

  test('OpenAI embeddings falls back after an anthropic candidate returns 501', async () => {
    const first = provider(ProviderProtocol.Anthropic, 'anthropic');
    const second = provider(ProviderProtocol.OpenAICompatible, 'compatible');
    const home = createServerTestHome();
    const response = await request(OPENAI_EMBEDDINGS, [first.value, second.value], home);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('raw:openai-compatible');
    expect(first.calls).toEqual({ model: 0, raw: 0, embed: 0 });
    expect(second.calls).toEqual({ model: 0, raw: 1, embed: 0 });
    expect(await recordedAttempts(home)).toEqual([
      expect.objectContaining({ outcome: 'failure', providerId: 'anthropic', statusCode: 501 }),
      expect.objectContaining({ outcome: 'success', providerId: 'compatible' }),
    ]);
  });

  test('Gemini embed and batch raw rewrite to the matching action', async () => {
    const embed = provider(ProviderProtocol.Gemini, 'gemini-embed');
    const embedResponse = await request(GEMINI_EMBED, [embed.value]);
    expect(embedResponse.status).toBe(200);
    expect(embed.calls.raw).toBe(1);
    expect(embed.calls.model).toBe(0);
    expect(embed.forwarded[0] && new URL(embed.forwarded[0].url).pathname).toBe('/v1beta/models/m:embedContent');
    expect(await embed.forwarded[0]?.json()).toMatchObject({ model: 'models/m' });

    const batch = provider(ProviderProtocol.Gemini, 'gemini-batch');
    const batchResponse = await request(GEMINI_BATCH_EMBED, [batch.value]);
    expect(batchResponse.status).toBe(200);
    expect(batch.forwarded[0] && new URL(batch.forwarded[0].url).pathname).toBe('/v1beta/models/m:batchEmbedContents');
    expect(await batch.forwarded[0]?.json()).toMatchObject({
      requests: [{ model: 'models/m' }, { model: 'models/m' }],
    });
  });

  test('Gemini embed convert writes a Gemini envelope, not OpenAI list', async () => {
    const fixture = provider(ProviderProtocol.OpenAICompatible, 'compatible', { embedding: true });
    const response = await request(GEMINI_EMBED, [fixture.value]);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      embedding: { values: [0.1, 0.2] },
      usageMetadata: { promptTokenCount: 3 },
    });
    expect(fixture.calls).toEqual({ model: 0, raw: 0, embed: 1 });
  });

  test('Kimi-style language-only raw declines embeddings and convert runs', async () => {
    const fixture = kimiStyleProvider();
    const response = await request(OPENAI_EMBEDDINGS, [fixture.value]);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ object: 'list', model: 'm' });
    expect(fixture.calls).toEqual({ model: 0, raw: 0, embed: 1 });
    expect(fixture.resolves).toEqual([
      expect.objectContaining({
        protocol: ProviderProtocol.OpenAICompatible,
        modelId: 'm',
        capability: 'embedding',
      }),
    ]);
  });

  test('Gemini unknown action is 404', async () => {
    const fixture = provider(ProviderProtocol.Gemini, 'gemini', { embedding: true });
    const response = await request({ path: '/v1beta/models/m:unknownAction', body: GEMINI_EMBED.body }, [
      fixture.value,
    ]);

    expect(response.status).toBe(404);
    expect(fixture.calls).toEqual({ model: 0, raw: 0, embed: 0 });
  });

  test('OpenAI convert that returns embeddings without recoverable usage is 502', async () => {
    const fixture = provider(ProviderProtocol.Gemini, 'gemini', {
      embedding: true,
      embedResult: { embeddings: [[0.1, 0.2]] },
    });
    const response = await request(OPENAI_EMBEDDINGS, [fixture.value]);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'upstream_error' } });
    expect(fixture.calls).toEqual({ model: 0, raw: 0, embed: 1 });
  });
});

type Calls = { model: number; raw: number; embed: number };
type ResolveInput = {
  readonly protocol: ProviderProtocol;
  readonly modelId: string;
  readonly capability?: 'language' | 'embedding';
};

function provider(
  protocol: ProviderProtocol,
  id: string,
  options: {
    readonly embedding?: boolean;
    readonly embedResult?: EmbeddingResult;
    readonly priority?: number;
  } = {},
): {
  readonly calls: Calls;
  readonly forwarded: Request[];
  readonly value: RuntimeProviderInstance;
} {
  const calls: Calls = { model: 0, raw: 0, embed: 0 };
  const forwarded: Request[] = [];
  const invokeRaw = async (request: Request) => {
    calls.raw += 1;
    forwarded.push(request);
    return new Response(`raw:${protocol}`);
  };
  return {
    calls,
    forwarded,
    value: {
      alias: { m: { model: 'm', preserve: false } },
      enabled: true,
      id,
      kind: ProviderKind.Api,
      models: ['m'],
      ...(options.priority === undefined ? {} : { priority: options.priority }),
      raw: {
        resolve: ({ protocol: inbound }: ResolveInput) => (inbound === protocol ? { invoke: invokeRaw } : undefined),
      },
      model: { invoke: () => ((calls.model += 1), languageStream()) },
      ...(options.embedding === true
        ? {
            embedding: {
              embed: async () => {
                calls.embed += 1;
                return options.embedResult ?? { embeddings: [[0.1, 0.2]], usage: { tokens: 3 } };
              },
            },
          }
        : {}),
    } satisfies RuntimeProviderInstance,
  };
}

function kimiStyleProvider(): {
  readonly calls: Calls;
  readonly resolves: ResolveInput[];
  readonly value: RuntimeProviderInstance;
} {
  const calls: Calls = { model: 0, raw: 0, embed: 0 };
  const resolves: ResolveInput[] = [];
  return {
    calls,
    resolves,
    value: {
      alias: { m: { model: 'm', preserve: false } },
      enabled: true,
      id: 'kimi',
      kind: ProviderKind.OAuth,
      models: ['m'],
      raw: {
        resolve: (input: ResolveInput) => {
          resolves.push(input);
          if (input.capability === 'embedding') return undefined;
          calls.raw += 1;
          return { invoke: async () => new Response('raw:language') };
        },
      },
      model: { invoke: () => ((calls.model += 1), languageStream()) },
      embedding: {
        embed: async () => {
          calls.embed += 1;
          return { embeddings: [[0.1, 0.2]], usage: { tokens: 3 } };
        },
      },
    } satisfies RuntimeProviderInstance,
  };
}

function languageStream(): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'language' });
      controller.close();
    },
  });
}

async function request(
  inbound: { readonly path: string; readonly body: unknown },
  providers: readonly RuntimeProviderInstance[],
  dbHome?: string,
) {
  const app = await createServer({
    config: { providers: {} },
    ...(dbHome === undefined ? {} : { dbHome }),
    providerInstances: providers,
  });
  return app.request(inbound.path, {
    body: JSON.stringify(inbound.body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

async function recordedAttempts(home: string) {
  const { requests } = await recorded(home);
  return requests[0]?.attempts ?? [];
}
