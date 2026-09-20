import { expect, mock, test } from 'bun:test';

import {
  createApiProvider,
  type EvaluationResult,
  type SystemOneContext,
  type SystemOneRequest,
  typeSafeSystemOneAdapter,
} from '@aio-proxy/core';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { defineProviderRouteSource } from '../../../../__tests__/pipeline-helpers';
import { lazyEvaluationTransport } from '../../../provider-runtime';
import { createAttemptResponseObservation } from '../../../response-observation';
import type { EvaluationDiscovery, EvaluationTransport, LazyEvaluationTransport } from '../../../runtime';
import type { RuntimeProviderInstance } from '../../../runtime';
import { attemptCandidates } from './attempt';
import type { AttemptStep, CandidateSlot, EvaluationAttemptLoopContext } from './context';
import { createAttemptEmitter } from './emit';
import { attemptEvaluationCandidate } from './evaluation';

const MODEL_ID = 'jev-latest';

const SYSTEM_ONE_BODY = {
  model: MODEL_ID,
  state: 'the assistant replied in French',
  questions: { q: { type: 'noul', instructions: 'Did it answer in French?' } },
};

const NOUL_RESULT: EvaluationResult = {
  answers: { q: { type: 'noul', noul: 0.93 } },
  usage: { inputTokens: 312, outputTokens: 48 },
};

// A choice answer the SDK returned without a distribution. `systemOneJson` refuses
// it; this layer owns turning that refusal into a candidate fallback.
const CHOICE_WITHOUT_PROBABILITIES: EvaluationResult = {
  answers: { q: { type: 'choice', choice: 'french' } },
};

function inbound(options: { readonly url?: string; readonly headers?: Record<string, string> } = {}): Request {
  return new Request(options.url ?? 'https://proxy.test/v1/systemone', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify(SYSTEM_ONE_BODY),
  });
}

type Harness = {
  readonly ctx: EvaluationAttemptLoopContext<SystemOneRequest, SystemOneContext>;
  readonly route: ReturnType<typeof defineProviderRouteSource>;
  readonly runLoop: (providers: readonly RuntimeProviderInstance[]) => Promise<Response>;
};

// Builds the invariants attemptCandidates would supply for one request, so each
// case exercises the real emitter, recorder, and session wiring. `rawRequest` is
// the parsed request's own object: `readRequestText` clones, so parse leaves the
// inbound body intact for the raw rewrite.
async function harness(rawRequest: Request = inbound()): Promise<Harness> {
  const route = defineProviderRouteSource([]);
  const request = await typeSafeSystemOneAdapter.parse(rawRequest, {});
  const session = route.source.requestRecorder.begin({
    inboundRequest: rawRequest,
    inboundProtocol: typeSafeSystemOneAdapter.protocol,
  });
  const resolution = route.source.logicalSessionStore.begin({
    requestedModelId: MODEL_ID,
    requestId: session.requestId,
    hints: { candidates: [] },
    headers: rawRequest.headers,
  });
  session.identify({ requestedModelId: MODEL_ID, resolution, mutateSessionState: true, streamRequested: false });
  const ctx: EvaluationAttemptLoopContext<SystemOneRequest, SystemOneContext> = {
    adapter: typeSafeSystemOneAdapter,
    context: {},
    rawRequest,
    request,
    requestedModelId: MODEL_ID,
    routerModels: undefined,
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
  };
  return {
    ctx,
    route,
    // The real candidate loop, so ordering is decided by the loop rather than by
    // the test. Providers are handed over in the order the router produced them.
    runLoop: (providers) =>
      attemptCandidates({
        adapter: typeSafeSystemOneAdapter,
        candidates: providers.map((provider) => ({
          provider,
          modelId: MODEL_ID,
          routing: {
            priority: provider.priority ?? 0,
            weight: 1,
            prioritySource: 'provider',
            weightSource: 'provider',
            configurationIndex: 0,
          },
          selectionSource: 'weighted_random',
        })),
        context: {},
        config: undefined,
        rawRequest,
        request,
        requestedModelId: MODEL_ID,
        session,
        source: route.source,
        streamRequested: false,
        deferRelease: () => {},
        resolution,
        release: () => {},
      }),
  };
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
      sourceProtocol: ProviderProtocol.TypeSafeSystemOne,
      selectionReason: 'weight',
    },
    inAttempt: (_targetProtocol, operation) => operation(),
    spanRef: { current: undefined },
  };
}

function fallbackFailure(step: AttemptStep): Response | undefined {
  return step.kind === 'fallback' ? step.lastFailure : undefined;
}

// Convert transport for a package whose probe already succeeded. `evaluate` routes
// through `discover` exactly as the real `lazyEvaluationTransport` does, so a
// dispatch that reads the resolver off either one behaves identically here.
function discoveredTransport(evaluate: EvaluationTransport['evaluate']): LazyEvaluationTransport {
  const discover = (): Promise<EvaluationDiscovery> => Promise.resolve({ kind: 'supported', evaluate });
  return {
    discover,
    async evaluate(invocation, options) {
      const discovered = await discover();
      if (discovered.kind !== 'supported') throw new TypeError('unreachable in this fixture');
      return await discovered.evaluate(invocation, options);
    },
  };
}

// An `ai-sdk` candidate: Task 9 attaches the convert transport to every one of them,
// so `model` is always present alongside it and presence proves nothing about
// evaluation. The real `lazyEvaluationTransport` is used wherever the probe verdict
// itself is under test, so the three states come from the production wrapper.
function convertProvider(
  id: string,
  evaluation: LazyEvaluationTransport,
  options: { readonly priority?: number } = {},
): RuntimeProviderInstance {
  return {
    id,
    kind: ProviderKind.AiSdk,
    enabled: true,
    capabilityIndex: { [MODEL_ID]: new Set(['evaluation']) },
    evaluation,
    model: {
      invoke: () => {
        throw new Error('evaluation must never call the language model transport');
      },
    },
    ...(options.priority === undefined ? {} : { priority: options.priority }),
  };
}

test('prefers raw when the candidate resolves a System One transport', async () => {
  const evaluate = mock(async () => NOUL_RESULT);
  const resolved: unknown[] = [];
  const forwarded: unknown[] = [];
  const provider: RuntimeProviderInstance = {
    id: 'typesafe-direct',
    kind: ProviderKind.Api,
    enabled: true,
    capabilityIndex: { [MODEL_ID]: new Set(['evaluation']) },
    evaluation: discoveredTransport(evaluate),
    raw: {
      resolve: (input) => {
        resolved.push(input);
        return input.protocol === ProviderProtocol.TypeSafeSystemOne
          ? {
              invoke: async (request: Request) => {
                forwarded.push(await request.clone().json());
                return Response.json({ model: MODEL_ID, answers: {} });
              },
            }
          : undefined;
      },
    },
  };
  const { ctx } = await harness();

  const step = await attemptEvaluationCandidate(ctx, slot(provider));

  expect(step.kind).toBe('return');
  expect(evaluate).not.toHaveBeenCalled();
  expect(resolved).toEqual([
    {
      protocol: ProviderProtocol.TypeSafeSystemOne,
      modelId: MODEL_ID,
      capability: 'evaluation',
      requestPath: '/v1/systemone',
    },
  ]);
  expect(forwarded[0]).toMatchObject({ model: MODEL_ID });
});

test('serves raw without awaiting convert discovery', async () => {
  // Discovery is gated on a promise that never settles, so an implementation that
  // awaits it before serving raw hangs instead of answering. Deliberately not a
  // latency assertion: a threshold would pass on a slow-but-awaited probe.
  const pending = new Promise<EvaluationDiscovery>(() => {});
  const provider: RuntimeProviderInstance = {
    id: 'typesafe-direct',
    kind: ProviderKind.Api,
    enabled: true,
    capabilityIndex: { [MODEL_ID]: new Set(['evaluation']) },
    evaluation: { discover: () => pending, evaluate: () => pending as never },
    raw: { resolve: () => ({ invoke: async () => Response.json({ model: MODEL_ID, answers: {} }) }) },
  };
  const { ctx } = await harness();

  const step = await attemptEvaluationCandidate(ctx, slot(provider));

  expect(step.kind).toBe('return');
  expect(step.kind === 'return' ? step.response.status : undefined).toBe(200);
});

test('strips caller credentials on the raw upstream request', async () => {
  // Anonymous admission: no caller keys are configured, so `stripCallerCredentials`
  // never ran and the caller's own secrets are still on the inbound request. A
  // matched caller key would have been stripped by middleware, making this pass
  // even if the attempt path did nothing.
  let upstream: { readonly url: string; readonly headers: Headers } | undefined;
  let handed: { readonly url: string; readonly headers: Headers } | undefined;
  const api = createApiProvider(
    {
      id: 'typesafe-direct',
      kind: ProviderKind.Api,
      enabled: true,
      protocol: ProviderProtocol.TypeSafeSystemOne,
      baseURL: 'https://api.typesafe.test',
      apiKey: 'provider-key',
      headers: { 'x-tenant': 'configured' },
      models: [MODEL_ID],
    },
    {
      fetch: (async (input, init) => {
        upstream = { url: String(input), headers: new Headers(init?.headers) };
        return Response.json({ model: MODEL_ID, answers: {} });
      }) as typeof globalThis.fetch,
    },
  );
  const provider: RuntimeProviderInstance = {
    id: api.id,
    kind: ProviderKind.Api,
    enabled: true,
    capabilityIndex: { [MODEL_ID]: new Set(['evaluation']) },
    raw: {
      resolve: () => ({
        invoke: (request) => {
          handed = { url: request.url, headers: new Headers(request.headers) };
          return api.passthrough(request);
        },
      }),
    },
  };
  const { ctx } = await harness(
    inbound({
      url: 'https://proxy.test/v1/systemone?key=caller-query-secret',
      headers: { authorization: 'Bearer caller-secret', 'x-api-key': 'caller-x-key', 'x-tenant': 'caller-tenant' },
    }),
  );

  const step = await attemptEvaluationCandidate(ctx, slot(provider));

  expect(step.kind).toBe('return');
  // The request this path hands the transport. An `api` endpoint transport strips
  // client credential headers on its own, so asserting only the upstream fetch
  // would stay green with the strip deleted — and a PLUGIN raw transport, which
  // this same resolve can return, has no such scrubbing of its own.
  expect(handed?.headers.get('authorization')).toBeNull();
  expect(handed?.headers.get('x-api-key')).toBeNull();
  expect(handed?.url).not.toContain('caller-query-secret');
  expect(upstream?.headers.get('authorization')).toBe('Bearer provider-key');
  expect(upstream?.headers.get('x-api-key')).toBeNull();
  expect(upstream?.headers.get('x-tenant')).toBe('configured');
  expect(upstream?.url).not.toContain('caller-query-secret');
  expect(upstream?.url).not.toContain('key=');
});

test('converts when there is no raw transport', async () => {
  const evaluate = mock(async () => NOUL_RESULT);
  const provider = convertProvider('gateway', discoveredTransport(evaluate));
  const { ctx } = await harness();

  const step = await attemptEvaluationCandidate(ctx, slot(provider));

  expect(step.kind).toBe('return');
  expect(step.kind === 'return' ? await step.response.json() : undefined).toEqual({
    model: MODEL_ID,
    answers: { q: { type: 'noul', noul: 0.93 } },
    usage: { input_tokens: 312, output_tokens: 48 },
  });
  expect(evaluate.mock.calls[0]?.[0]).toEqual({
    state: 'the assistant replied in French',
    questions: { q: { type: 'noul', instructions: 'Did it answer in French?' } },
  });
});

test('falls back when convert yields a choice answer with no probabilities', async () => {
  const provider = convertProvider(
    'gateway',
    discoveredTransport(async () => CHOICE_WITHOUT_PROBABILITIES),
  );
  const { ctx } = await harness();

  const step = await attemptEvaluationCandidate(ctx, slot(provider, { hasNext: true }));

  expect(step.kind).toBe('fallback');
  const failure = fallbackFailure(step);
  expect(failure?.status).toBe(501);
  expect(await failure?.json()).toEqual({
    message: 'Unsupported: evaluation_distribution',
    error_type: 'not_supported_error',
  });
});

test('excludes a candidate whose package genuinely has no evaluation resolver', async () => {
  // The transport is attached to EVERY ai-sdk provider, so only the probe can
  // answer. Reading `provider.evaluation !== undefined` instead admits this
  // candidate and reaches an invoke the wrapper can only reject.
  const provider = convertProvider(
    'chat-only',
    lazyEvaluationTransport('chat-only', async () => ({})),
  );
  const { ctx } = await harness();

  const step = await attemptEvaluationCandidate(ctx, slot(provider, { hasNext: true }));

  expect(step.kind).toBe('fallback');
  expect(fallbackFailure(step)?.status).toBe(501);
  expect(await fallbackFailure(step)?.json()).toEqual({
    message: 'Unsupported: evaluation_convert',
    error_type: 'not_supported_error',
  });
});

test('surfaces a failed discovery in the candidate position, then falls back', async () => {
  // A package that could not be installed is a candidate failure, not a routing
  // fact. It stays off `handleAttemptError` so the answer names the real fault
  // rather than the generic upstream 502 `errors.provider` returns for an
  // unrecognized throw.
  const provider = convertProvider(
    'broken',
    lazyEvaluationTransport('broken', async () => null),
  );
  const { ctx } = await harness();

  const step = await attemptEvaluationCandidate(ctx, slot(provider, { hasNext: true }));

  expect(step.kind).toBe('fallback');
  expect(fallbackFailure(step)?.status).toBe(501);
  expect(await fallbackFailure(step)?.json()).toEqual({
    message: 'Unsupported: evaluation_discovery',
    error_type: 'not_supported_error',
  });
});

test('a candidate with neither System One raw nor a convert transport is unsupported', async () => {
  const provider: RuntimeProviderInstance = {
    id: 'openai-compatible',
    kind: ProviderKind.Api,
    enabled: true,
    capabilityIndex: { [MODEL_ID]: new Set(['language']) },
    raw: {
      resolve: ({ protocol }) =>
        protocol === ProviderProtocol.OpenAICompatible ? { invoke: async () => new Response('no') } : undefined,
    },
  };
  const { ctx } = await harness();

  const step = await attemptEvaluationCandidate(ctx, slot(provider, { hasNext: true }));

  expect(step.kind).toBe('fallback');
  expect(await fallbackFailure(step)?.json()).toEqual({
    message: 'Unsupported: evaluation_convert',
    error_type: 'not_supported_error',
  });
});

test('does not let a backup whose discovery failed pre-empt a healthy primary', async () => {
  // The backup's probe has already resolved to a failure before the loop starts.
  // A prepared failure must keep its own position in candidate order, never be
  // hoisted ahead of a healthy higher-priority candidate.
  const backup = convertProvider(
    'backup',
    lazyEvaluationTransport('backup', async () => null),
    { priority: 0 },
  );
  await backup.evaluation?.discover();
  const primaryEvaluate = mock(async () => NOUL_RESULT);
  const primary = convertProvider('primary', discoveredTransport(primaryEvaluate), { priority: 10 });
  const { route, runLoop } = await harness();

  const response = await runLoop([primary, backup]);

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ model: MODEL_ID });
  expect(primaryEvaluate).toHaveBeenCalled();
  await route.recording.settle();
  expect(route.recording.attempts.map((attempt) => attempt.providerId)).toEqual(['primary']);
});

test('a failed discovery falls back to the next candidate through the real loop', async () => {
  const broken = convertProvider(
    'broken',
    lazyEvaluationTransport('broken', async () => null),
  );
  const healthy = convertProvider(
    'healthy',
    discoveredTransport(async () => NOUL_RESULT),
  );
  const { route, runLoop } = await harness();

  const response = await runLoop([broken, healthy]);

  expect(response.status).toBe(200);
  await route.recording.settle();
  expect(route.recording.attempts.map((attempt) => attempt.providerId)).toEqual(['broken', 'healthy']);
});

test('a throw from the evaluation transport is answered, not propagated', async () => {
  // Discovery succeeded and `evaluate` itself threw -- a network drop, a wrapped
  // upstream 5xx, a provider bug. The throw leaves `attemptEvaluationCandidate` and
  // is caught by the loop, which hands it to `handleAttemptError`; that rethrows
  // whatever `errors.provider` cannot map. As the only candidate there is nothing
  // to fall back to, so mapping is the whole difference between a 502 and an
  // exception escaping the pipeline.
  const provider = convertProvider(
    'flaky',
    discoveredTransport(async () => {
      throw new Error('socket hang up');
    }),
  );
  const { runLoop } = await harness();

  const response = await runLoop([provider]);

  expect(response.status).toBe(502);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(await response.json()).toEqual({
    message: 'Upstream evaluation provider failed',
    error_type: 'upstream_error',
  });
});

test('a candidate whose evaluate throws falls back to a healthy one through the real loop', async () => {
  // CLAUDE.md's routing rule made executable: "On provider failure, try the next
  // candidate for the same model." With `errors.provider` declining, the throw
  // leaves the loop through `handleAttemptError` and the healthy second candidate
  // is never reached, so this request fails with a working provider available.
  const failing = convertProvider(
    'flaky',
    discoveredTransport(async () => {
      throw new Error('socket hang up');
    }),
  );
  const healthyEvaluate = mock(async () => NOUL_RESULT);
  const healthy = convertProvider('healthy', discoveredTransport(healthyEvaluate));
  const { route, runLoop } = await harness();

  const response = await runLoop([failing, healthy]);

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ model: MODEL_ID, answers: { q: { type: 'noul', noul: 0.93 } } });
  expect(healthyEvaluate).toHaveBeenCalled();
  await route.recording.settle();
  expect(route.recording.attempts.map((attempt) => attempt.providerId)).toEqual(['flaky', 'healthy']);
});

test('records the reported evaluation tokens on the finished trace', async () => {
  // Without this the convert path settles a synthetic success and bills nothing:
  // a 200 leaves no usage row at all, so the request is served for free.
  const provider = convertProvider(
    'gateway',
    discoveredTransport(async () => NOUL_RESULT),
  );
  const { ctx, route } = await harness();

  const step = await attemptEvaluationCandidate(ctx, slot(provider));

  expect(step.kind).toBe('return');
  await route.recording.settle();
  expect(route.recording.finals[0]).toMatchObject({
    outcome: 'success',
    finalProviderId: 'gateway',
    usage: { providerId: 'gateway', modelId: MODEL_ID, inputTokens: 312, outputTokens: 48, totalTokens: 360 },
  });
});

test('records an attributed row when convert reports no usage at all', async () => {
  // `usage` is nullish in the System One schema, so an upstream that reports no
  // counts is not an error. The row still has to exist to attribute the request.
  const provider = convertProvider(
    'gateway',
    discoveredTransport(async () => ({ answers: { q: { type: 'noul', noul: 0.5 } } })),
  );
  const { ctx, route } = await harness();

  const step = await attemptEvaluationCandidate(ctx, slot(provider));

  expect(step.kind).toBe('return');
  await route.recording.settle();
  expect(route.recording.finals[0]?.usage).toMatchObject({ providerId: 'gateway', modelId: MODEL_ID });
  expect(route.recording.finals[0]?.usage?.inputTokens).toBeUndefined();
});

test('bills evaluation against the upstream cost the provider reports', async () => {
  const provider: RuntimeProviderInstance = {
    ...convertProvider(
      'oauth',
      discoveredTransport(async () => NOUL_RESULT),
    ),
    upstreamMetadata: { [MODEL_ID]: { cost: { input: 5 } } },
  };
  const { ctx, route } = await harness();

  const step = await attemptEvaluationCandidate(ctx, slot(provider));

  expect(step.kind).toBe('return');
  expect(route.usage.evaluation[0]?.configPrice).toEqual({ id: MODEL_ID, input: 5 });
});
