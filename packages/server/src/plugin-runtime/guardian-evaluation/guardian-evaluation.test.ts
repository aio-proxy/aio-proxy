import { expect, spyOn, test } from 'bun:test';

import { type EvaluationResult, Router } from '@aio-proxy/core';
import type { TraceCompletion } from '@aio-proxy/core/db';
import { withRequestId } from '@aio-proxy/logger';
import { ProviderKind } from '@aio-proxy/types';

import { defineProviderRouteSource } from '../../../__tests__/pipeline-helpers';
import { currentDebugRequestLogScope, withRequestLogContext } from '../../request-logging';
import { attributeName, createRequestTraceRecorder } from '../../request-tracing';
import * as evaluationTransport from '../../routes/pipeline/attempt/evaluation';
import type { RuntimeProviderInstance } from '../../runtime';
import { createUsageCapture } from '../../usage-capture';
import { createGuardianEvaluate } from './guardian-evaluation';

const body = {
  model: 'jev-latest',
  state: { input: [], pending_action: {} },
  questions: { outcome: { type: 'choice' as const, instructions: 'Decide', criteria: { allow: null, deny: null } } },
};
const logicalRequest = {
  requestId: 'parent-request',
  session: { key: 'sha256:parent' as const, source: 'generated' as const },
};
const answer = { answers: { outcome: { type: 'choice', choice: 'allow', probabilities: { allow: 1, deny: 0 } } } };
function provider(id: string, invoke: (request: Request) => Promise<Response>): RuntimeProviderInstance {
  return {
    id,
    kind: ProviderKind.Api,
    enabled: true,
    models: ['jev-latest'],
    capabilityIndex: { 'jev-latest': new Set(['evaluation']) },
    raw: { resolve: () => ({ invoke }) },
  };
}
function harness(providers: RuntimeProviderInstance[]) {
  const route = defineProviderRouteSource([]);
  let router = new Router(providers);
  let releases = 0;
  const source = {
    ...route.source,
    usageCapture: createUsageCapture(),
    acquireProviderSnapshot: () => ({
      snapshot: { ...route.source.currentProviderSnapshot(), router, providers },
      release: () => {
        releases++;
      },
    }),
  };
  return {
    ...route,
    source,
    host: createGuardianEvaluate(() => source, 'chatgpt'),
    releases: () => releases,
    swap: (next: RuntimeProviderInstance[]) => {
      router = new Router(next);
    },
  };
}
const input = () => ({
  providerId: 'selected',
  modelId: 'jev-latest',
  body,
  signal: new AbortController().signal,
  logicalRequest,
});
test('dispatches only the qualified target without caller credentials', async () => {
  const calls: string[] = [];
  const selected = provider('selected', async (request) => {
    calls.push('selected');
    expect([...request.headers.keys()]).toEqual(['content-type']);
    expect(await request.json()).toEqual(body);
    return Response.json(answer);
  });
  const h = harness([
    selected,
    provider('other', async () => {
      calls.push('other');
      return Response.json(answer);
    }),
  ]);
  expect(await h.host(input())).toEqual(answer);
  expect(calls).toEqual(['selected']);
  expect(h.releases()).toBe(1);
  await h.recording.settle();
  expect(h.recording.attempts[0]?.selectionSource).toBe('provider_qualified');
});
test('rejects disabled and slash alias targets before dispatch', async () => {
  let calls = 0;
  const other = {
    ...provider('other', async () => {
      calls++;
      return Response.json(answer);
    }),
    alias: { 'selected/jev-latest': { model: 'jev-latest', preserve: false } },
  };
  for (const providers of [
    [other],
    [{ ...provider('selected', async () => Response.json(answer)), enabled: false }, other],
  ]) {
    const h = harness(providers);
    await expect(h.host(input())).rejects.toMatchObject({ reason: 'target_unavailable' });
    expect(h.releases()).toBe(1);
  }
  expect(calls).toBe(0);
});
test('rejects recursive target and never falls back after selected failure', async () => {
  let calls = 0;
  const h = harness([
    provider('chatgpt', async () => {
      calls++;
      return Response.json(answer);
    }),
    provider('selected', async () => {
      throw new Error('secret');
    }),
    provider('other', async () => {
      calls++;
      return Response.json(answer);
    }),
  ]);
  await expect(h.host({ ...input(), providerId: 'chatgpt' })).rejects.toMatchObject({ reason: 'recursive_target' });
  await expect(h.host(input())).rejects.toMatchObject({ reason: 'transport_failed' });
  expect(calls).toBe(0);
});
test('holds the leased snapshot until body consumption across replacement', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const opened = Promise.withResolvers<void>();
  const h = harness([
    provider('selected', async () => {
      opened.resolve();
      return new Response(
        new ReadableStream({
          start(c) {
            controller = c;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }),
  ]);
  const pending = h.host(input());
  await opened.promise;
  h.swap([
    provider('selected', async () => {
      throw new Error('new snapshot must not be used');
    }),
  ]);
  expect(h.releases()).toBe(0);
  controller.enqueue(new TextEncoder().encode(JSON.stringify(answer)));
  controller.close();
  expect(await pending).toEqual(answer);
  expect(h.releases()).toBe(1);
});
test('abort rejects ignored transport and cancels late body', async () => {
  const late = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  let cancelled = false;
  const h = harness([
    provider('selected', () => {
      started.resolve();
      return late.promise;
    }),
  ]);
  const controller = new AbortController();
  const pending = h.host({ ...input(), signal: controller.signal });
  await started.promise;
  controller.abort();
  await expect(pending).rejects.toBeDefined();
  expect(h.releases()).toBe(1);
  late.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await Bun.sleep(0);
  expect(cancelled).toBe(true);
});

function converted(result: EvaluationResult | undefined): RuntimeProviderInstance {
  const evaluate = async () => {
    if (result === undefined) throw new Error('unsupported must not invoke');
    return result;
  };
  return {
    ...provider('selected', async () => {
      throw new Error('raw must not run');
    }),
    kind: ProviderKind.AiSdk,
    raw: { resolve: () => undefined },
    evaluation: {
      evaluate,
      discover: async () => (result === undefined ? { kind: 'unsupported' } : { kind: 'supported', evaluate }),
    },
    upstreamMetadata: { 'jev-latest': { cost: { input: 1000000 } } },
  };
}
test('unsupported ai-sdk discovery never tries another Provider', async () => {
  let calls = 0;
  const h = harness([
    converted(undefined),
    provider('other', async () => {
      calls++;
      return Response.json(answer);
    }),
  ]);
  await expect(h.host(input())).rejects.toMatchObject({ reason: 'unsupported' });
  expect(calls).toBe(0);
  expect(h.releases()).toBe(1);
});
test('invalid converted output retains usage once in a separate linked internal trace', async () => {
  const h = harness([
    converted({
      answers: { outcome: { type: 'choice', choice: 'allow' } },
      usage: { inputTokens: 7, outputTokens: 0 },
    }),
  ]);
  const completions: TraceCompletion[] = [];
  const recorder = createRequestTraceRecorder({
    store: {
      startRoot() {},
      prune() {},
      recover() {},
      complete(value) {
        completions.push(value);
        return true;
      },
    },
  });
  const parent = withRequestId(logicalRequest.requestId, () =>
    recorder.begin({ inboundRequest: new Request('http://proxy/responses'), inboundProtocol: 'openai-response' }),
  );
  const host = createGuardianEvaluate(() => ({ ...h.source, requestRecorder: recorder }), 'chatgpt');
  await withRequestLogContext(
    { requestId: parent.requestId, rootContext: parent.rootContext, debug: true, logger: () => {} },
    async () => {
      await expect(host(input())).rejects.toMatchObject({ reason: 'invalid_response' });
    },
  );
  parent.finish({ outcome: 'success' });
  expect(completions).toHaveLength(2);
  const internal = completions[0]!;
  expect(internal.traceId).not.toBe(parent.traceId);
  const root = internal.spans.find((span) => span.spanId === internal.rootSpanId)!;
  expect(root.attributes[attributeName.requestId]).not.toBe(parent.requestId);
  expect(root.attributes[attributeName.guardianParentRequestId]).toBe(parent.requestId);
  expect(root.links[0]?.traceId).toBe(parent.traceId);
  expect(internal.summary.usage).toMatchObject({ providerId: 'selected', modelId: 'jev-latest', inputTokens: 7 });
  expect(completions[1]?.summary.usage).toBeUndefined();
  expect(completions.filter((value) => value.summary.usage !== undefined)).toHaveLength(1);
  expect(completions.reduce((sum, value) => sum + (value.summary.usage?.estimatedCostUsd ?? 0), 0)).toBe(7);
});
test('raw invalid distribution retains available selected-Provider usage', async () => {
  const h = harness([
    provider('selected', async () =>
      Response.json({
        answers: { outcome: { type: 'choice', choice: 'allow' } },
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
    ),
  ]);
  await expect(h.host(input())).rejects.toMatchObject({ reason: 'invalid_response' });
  await h.recording.settle();
  expect(h.recording.finals[0]?.usage).toMatchObject({ providerId: 'selected', inputTokens: 12, outputTokens: 3 });
});
test('abort cancels an open response before releasing its snapshot', async () => {
  let cancelled = false;
  const started = Promise.withResolvers<void>();
  const h = harness([
    provider(
      'selected',
      async () =>
        new Response(
          new ReadableStream({
            pull() {
              started.resolve();
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    ),
  ]);
  const controller = new AbortController();
  const pending = h.host({ ...input(), signal: controller.signal });
  await started.promise;
  controller.abort();
  await expect(pending).rejects.toBeDefined();
  expect(cancelled).toBe(true);
  expect(h.releases()).toBe(1);
});
test.each([
  ['bad JSON', () => new Response('{broken', { headers: { 'content-type': 'application/json' } }), 'invalid_response'],
  [
    'oversized',
    () => new Response(' '.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
    'response_too_large',
  ],
  ['HTTP failure', () => new Response('secret', { status: 503 }), 'transport_failed'],
] as const)('bounds unavailable reason for %s', async (_name, response, reason) => {
  const h = harness([provider('selected', async () => response())]);
  await expect(h.host(input())).rejects.toMatchObject({ reason, message: reason });
  expect(h.releases()).toBe(1);
});

test('parent credentials and trace link stay off the private raw dispatch', async () => {
  let dispatched = false;
  const h = harness([
    provider('selected', async (request) => {
      dispatched = true;
      expect([...request.headers.keys()]).toEqual(['content-type']);
      expect(request.url).toBe('http://aio-proxy.invalid/v1/systemone');
      expect(currentDebugRequestLogScope()).toBeUndefined();
      return Response.json(answer);
    }),
  ]);
  const parent = h.source.requestRecorder.begin({
    inboundRequest: new Request('https://untrusted.test/responses?key=caller-secret', {
      headers: { authorization: 'Bearer caller-secret', 'x-api-key': 'oauth-secret' },
    }),
    inboundProtocol: 'openai-response',
  });
  await withRequestLogContext(
    { requestId: parent.requestId, rootContext: parent.rootContext, debug: true, logger: () => {} },
    () => h.host(input()),
  );
  parent.finish({ outcome: 'success' });
  expect(dispatched).toBe(true);
  expect(h.logs).toEqual([]);
});
test('a subsequent invocation rechecks the qualified route after replacement', async () => {
  const h = harness([provider('selected', async () => Response.json(answer))]);
  expect(await h.host(input())).toEqual(answer);
  let otherCalls = 0;
  h.swap([
    {
      ...provider('other', async () => {
        otherCalls++;
        return Response.json(answer);
      }),
      alias: { 'selected/jev-latest': { model: 'jev-latest', preserve: false } },
    },
  ]);
  await expect(h.host(input())).rejects.toMatchObject({ reason: 'target_unavailable' });
  expect(otherCalls).toBe(0);
  expect(h.releases()).toBe(2);
});

test('dispatches the exact candidate object returned by the leased snapshot', async () => {
  const h = harness([
    provider('system-one-local', async () => Response.json(answer)),
    provider('other', async () => {
      throw new Error('wrong Provider');
    }),
  ]);
  const lease = h.source.acquireProviderSnapshot();
  const candidate = lease.snapshot.router.resolve('system-one-local/jev-latest')[0]!;
  const resolve = spyOn(lease.snapshot.router, 'resolve').mockReturnValue([candidate]);
  const select = spyOn(evaluationTransport, 'selectEvaluationTransport');
  try {
    const result = await h.host({ ...input(), providerId: 'system-one-local' });
    expect(result).toEqual(answer);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('system-one-local/jev-latest');
    expect(select.mock.calls[0]?.[0].candidate).toBe(candidate);
    expect(candidate.selectionSource).toBe('provider_qualified');
  } finally {
    resolve.mockRestore();
    select.mockRestore();
    lease.release();
  }
});
