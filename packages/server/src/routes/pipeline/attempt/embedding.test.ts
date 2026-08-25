import { expect, mock, test } from 'bun:test';

import {
  type EmbeddingProtocolAdapter,
  geminiEmbeddingsAdapter,
  type GeminiEmbeddingsContext,
  type GeminiEmbeddingsRequest,
  openAIEmbeddingsAdapter,
  type OpenAIEmbeddingsRequest,
  parseGeminiBatchEmbedContents,
  parseGeminiEmbedContent,
} from '@aio-proxy/core';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { defineProviderRouteSource, settleRecording } from '../../../../__tests__/pipeline-helpers';
import { createAttemptResponseObservation } from '../../../response-observation';
import type { RuntimeProviderInstance } from '../../../runtime';
import type { CandidateSlot, EmbeddingAttemptLoopContext } from './context';
import { attemptEmbeddingCandidate } from './embedding';
import { createAttemptEmitter } from './emit';

const MODEL_ID = 'text-embedding-3-small';

type Harness<TRequest, TContext> = {
  readonly ctx: EmbeddingAttemptLoopContext<TRequest, TContext>;
  readonly route: ReturnType<typeof defineProviderRouteSource>;
};

// Builds the invariants attemptCandidates would supply for one request, so each
// case exercises the real emitter / recorder / usage capture wiring.
function harness<TRequest, TContext>(
  adapter: EmbeddingProtocolAdapter<TRequest, TContext>,
  request: TRequest,
  context: TContext,
): Harness<TRequest, TContext> {
  const route = defineProviderRouteSource([]);
  const rawRequest = new Request('https://proxy.test/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ID, input: 'hello' }),
  });
  const session = route.source.requestRecorder.begin({ inboundRequest: rawRequest, inboundProtocol: adapter.protocol });
  const resolution = route.source.logicalSessionStore.begin({
    requestedModelId: MODEL_ID,
    requestId: session.requestId,
    hints: { candidates: [], transcript: 'hello' },
    headers: rawRequest.headers,
  });
  session.identify({ requestedModelId: MODEL_ID, resolution, mutateSessionState: true, streamRequested: false });
  return {
    route,
    ctx: {
      adapter,
      context,
      rawRequest,
      request,
      requestedModelId: MODEL_ID,
      session,
      source: route.source,
      logicalRequest: resolution.context,
      routingContinuity: { updatesAffinity: false },
      sessionIdentity: resolution.identity,
      streamRequested: false,
      emitter: createAttemptEmitter(session, false),
      release: () => {},
      deferRelease: () => {},
      logFailure: () => {},
      cooldown: route.source.cooldown,
      retryAfterCapMs: 30_000,
    },
  };
}

function ctx(
  adapter: EmbeddingProtocolAdapter<OpenAIEmbeddingsRequest, Record<never, never>>,
  request: OpenAIEmbeddingsRequest = { model: MODEL_ID, input: 'hello' },
): EmbeddingAttemptLoopContext<OpenAIEmbeddingsRequest, Record<never, never>> {
  return harness(adapter, request, {}).ctx;
}

function geminiHarness(
  request: GeminiEmbeddingsRequest,
  action: GeminiEmbeddingsContext['action'] = 'embedContent',
): Harness<GeminiEmbeddingsRequest, GeminiEmbeddingsContext> {
  return harness(geminiEmbeddingsAdapter, request, { model: MODEL_ID, action });
}

function slot(provider: RuntimeProviderInstance, options: { readonly hasNext?: boolean } = {}): CandidateSlot {
  const startedAt = performance.now();
  return {
    index: 0,
    candidate: {
      provider,
      modelId: MODEL_ID,
      routing: {
        priority: 0,
        weight: 1,
        prioritySource: 'provider',
        weightSource: 'provider',
        configurationIndex: 0,
      },
      selectionSource: 'weighted_random',
    },
    startedAt,
    observation: createAttemptResponseObservation({ startedAt }),
    hasNext: options.hasNext ?? false,
    trace: {
      routingContractVersion: 2,
      providerWeight: 1,
      effectivePriority: 0,
      effectiveWeight: 1,
      prioritySource: 'provider',
      weightSource: 'provider',
      selectionSource: 'weighted_random',
      sourceProtocol: ProviderProtocol.OpenAICompatible,
      selectionReason: 'weight',
    },
    inAttempt: (_targetProtocol, operation) => operation(),
    spanRef: { current: undefined },
  };
}

function fallbackFailure(step: Awaited<ReturnType<typeof attemptEmbeddingCandidate>>): Response | undefined {
  return step.kind === 'fallback' ? step.lastFailure : undefined;
}

test('language-only raw that returns undefined falls through to embedding convert', async () => {
  const embed = mock(async () => ({ embeddings: [[0.1]], usage: { tokens: 2 } }));
  const provider = {
    id: 'kimi',
    kind: ProviderKind.OAuth,
    enabled: true,
    raw: {
      resolve: ({ capability }: { capability?: string }) =>
        capability === 'embedding' ? undefined : { invoke: async () => new Response('nope') },
    },
    embedding: { embed },
  } satisfies RuntimeProviderInstance;

  const response = await attemptEmbeddingCandidate(ctx(openAIEmbeddingsAdapter), slot(provider));

  expect(response.kind).toBe('return');
  expect(embed).toHaveBeenCalled();
});

test('OpenAI convert with unknown usage after recovery is 502 and can fallback', async () => {
  const provider = {
    id: 'g',
    kind: ProviderKind.Api,
    enabled: true,
    embedding: { embed: async () => ({ embeddings: [[0.1]] }) },
  } satisfies RuntimeProviderInstance;

  const step = await attemptEmbeddingCandidate(ctx(openAIEmbeddingsAdapter), slot(provider, { hasNext: true }));

  expect(step.kind).toBe('fallback');
  const failure = fallbackFailure(step);
  expect(failure?.status).toBe(502);
  expect(await failure?.json()).toMatchObject({ error: { code: 'upstream_error' } });
});

test('raw non-fallback status does not retry convert on the same candidate', async () => {
  const embed = mock(async () => ({ embeddings: [[0.1]], usage: { tokens: 2 } }));
  const provider = {
    id: 'compatible',
    kind: ProviderKind.Api,
    enabled: true,
    raw: {
      resolve: () => ({
        invoke: async () => new Response('bad request', { status: 400 }),
      }),
    },
    embedding: { embed },
  } satisfies RuntimeProviderInstance;

  const step = await attemptEmbeddingCandidate(ctx(openAIEmbeddingsAdapter), slot(provider, { hasNext: true }));

  expect(step.kind).toBe('return');
  expect(step.kind === 'return' ? step.response.status : undefined).toBe(400);
  expect(embed).not.toHaveBeenCalled();
});

test('raw throw does not retry convert on the same candidate', async () => {
  const embed = mock(async () => ({ embeddings: [[0.1]], usage: { tokens: 2 } }));
  const provider = {
    id: 'compatible',
    kind: ProviderKind.Api,
    enabled: true,
    raw: {
      resolve: () => ({
        invoke: async () => {
          throw new Error('raw transport failed');
        },
      }),
    },
    embedding: { embed },
  } satisfies RuntimeProviderInstance;

  await expect(
    attemptEmbeddingCandidate(ctx(openAIEmbeddingsAdapter), slot(provider, { hasNext: true })),
  ).rejects.toThrow('raw transport failed');
  expect(embed).not.toHaveBeenCalled();
});

test('same-protocol embedding raw passes through without converting', async () => {
  const embed = mock(async () => ({ embeddings: [[0.1]], usage: { tokens: 2 } }));
  const forwarded: Request[] = [];
  const provider = {
    id: 'compatible',
    kind: ProviderKind.Api,
    enabled: true,
    raw: {
      resolve: () => ({
        invoke: async (request: Request) => {
          forwarded.push(request);
          return Response.json({ object: 'list', data: [] });
        },
      }),
    },
    embedding: { embed },
  } satisfies RuntimeProviderInstance;

  const step = await attemptEmbeddingCandidate(ctx(openAIEmbeddingsAdapter), slot(provider));

  expect(step.kind).toBe('return');
  expect(embed).not.toHaveBeenCalled();
  expect(forwarded).toHaveLength(1);
  expect(await forwarded[0]?.json()).toMatchObject({ model: MODEL_ID });
});

test('declines OpenAI token-id input with a fallback-capable 501', async () => {
  const embed = mock(async () => ({ embeddings: [[0.1]], usage: { tokens: 2 } }));
  const provider = {
    id: 'compatible',
    kind: ProviderKind.Api,
    enabled: true,
    embedding: { embed },
  } satisfies RuntimeProviderInstance;

  const step = await attemptEmbeddingCandidate(
    ctx(openAIEmbeddingsAdapter, { model: MODEL_ID, input: [1, 2, 3] }),
    slot(provider, { hasNext: true }),
  );

  expect(step.kind).toBe('fallback');
  expect(fallbackFailure(step)?.status).toBe(501);
  expect(embed).not.toHaveBeenCalled();
});

test('declines a Gemini title with a fallback-capable 501 before calling the transport', async () => {
  const embed = mock(async () => ({ embeddings: [[0.1]], usage: { tokens: 2 } }));
  const provider = {
    id: 'google',
    kind: ProviderKind.Api,
    enabled: true,
    embedding: { embed },
  } satisfies RuntimeProviderInstance;
  const { ctx: geminiCtx } = geminiHarness(
    parseGeminiEmbedContent({ content: { parts: [{ text: 'doc' }] }, embedContentConfig: { title: 'Doc' } }),
  );

  const step = await attemptEmbeddingCandidate(geminiCtx, slot(provider, { hasNext: true }));

  expect(step.kind).toBe('fallback');
  expect(fallbackFailure(step)?.status).toBe(501);
  expect(embed).not.toHaveBeenCalled();
});

test('Gemini convert omits usageMetadata instead of failing when usage is unknown', async () => {
  const provider = {
    id: 'google',
    kind: ProviderKind.Api,
    enabled: true,
    embedding: { embed: async () => ({ embeddings: [[0.1, 0.2]] }) },
  } satisfies RuntimeProviderInstance;
  const { ctx: geminiCtx } = geminiHarness(parseGeminiEmbedContent({ content: { parts: [{ text: 'doc' }] } }));

  const step = await attemptEmbeddingCandidate(geminiCtx, slot(provider));

  expect(step.kind).toBe('return');
  const body = step.kind === 'return' ? await step.response.json() : undefined;
  expect(body).toEqual({ embedding: { values: [0.1, 0.2] } });
});

test('Gemini batch convert writes the batch envelope from the request action', async () => {
  const provider = {
    id: 'google',
    kind: ProviderKind.Api,
    enabled: true,
    embedding: { embed: async () => ({ embeddings: [[0.1], [0.2]], usage: { tokens: 4 } }) },
  } satisfies RuntimeProviderInstance;
  const { ctx: geminiCtx } = geminiHarness(
    parseGeminiBatchEmbedContents({
      requests: [{ content: { parts: [{ text: 'one' }] } }, { content: { parts: [{ text: 'two' }] } }],
    }),
    'batchEmbedContents',
  );

  const step = await attemptEmbeddingCandidate(geminiCtx, slot(provider));

  expect(step.kind).toBe('return');
  const body = step.kind === 'return' ? await step.response.json() : undefined;
  expect(body).toEqual({
    embeddings: [{ values: [0.1] }, { values: [0.2] }],
    usageMetadata: { promptTokenCount: 4 },
  });
});

test('encodes base64 vectors when the request asked for that encoding format', async () => {
  const provider = {
    id: 'compatible',
    kind: ProviderKind.Api,
    enabled: true,
    embedding: { embed: async () => ({ embeddings: [[0.5]], usage: { tokens: 1 } }) },
  } satisfies RuntimeProviderInstance;

  const step = await attemptEmbeddingCandidate(
    ctx(openAIEmbeddingsAdapter, { model: MODEL_ID, input: 'hello', encoding_format: 'base64' }),
    slot(provider),
  );

  expect(step.kind).toBe('return');
  const body = step.kind === 'return' ? await step.response.json() : undefined;
  expect(typeof body?.data?.[0]?.embedding).toBe('string');
});

test('a provider with neither embedding raw nor an embedding transport is unsupported', async () => {
  const provider = {
    id: 'language-only',
    kind: ProviderKind.AiSdk,
    enabled: true,
    model: { invoke: () => new ReadableStream() },
  } as unknown as RuntimeProviderInstance;

  const step = await attemptEmbeddingCandidate(ctx(openAIEmbeddingsAdapter), slot(provider, { hasNext: true }));

  expect(step.kind).toBe('fallback');
  expect(fallbackFailure(step)?.status).toBe(501);
});

test('records the reported embedding tokens on the finished trace', async () => {
  const provider = {
    id: 'compatible',
    kind: ProviderKind.Api,
    enabled: true,
    embedding: { embed: async () => ({ embeddings: [[0.1]], usage: { tokens: 7 } }) },
  } satisfies RuntimeProviderInstance;
  const { ctx: openAICtx, route } = harness(openAIEmbeddingsAdapter, { model: MODEL_ID, input: 'hello' }, {});

  const step = await attemptEmbeddingCandidate(openAICtx, slot(provider));
  expect(step.kind).toBe('return');
  await settleRecording(route.recording);

  expect(route.recording.finals[0]).toMatchObject({
    outcome: 'success',
    finalProviderId: 'compatible',
    usage: { inputTokens: 7, totalTokens: 7 },
  });
});
