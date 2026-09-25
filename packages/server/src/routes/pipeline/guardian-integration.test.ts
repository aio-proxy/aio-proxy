import { expect, spyOn, test } from 'bun:test';

import { createPluginRegistryHost } from '@aio-proxy/core';
import type { TraceCompletion } from '@aio-proxy/core/db';
import { ConfigSchema, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { openAIChatGPTClientId } from '../../../../plugins/openai-chatgpt/rslib.config';
import {
  guardianRequest,
  syntheticGuardianInput,
} from '../../../../plugins/openai-chatgpt/src/runtime/guardian/fixture';
import { guardianQuestions } from '../../../../plugins/openai-chatgpt/src/runtime/guardian/questions';
import { guardianPayloadHint } from '../../../../plugins/openai-chatgpt/src/runtime/guardian/request';
import { defineProviderRouteSource, rawProvider } from '../../../__tests__/pipeline-helpers';
import { createServerLogSink } from '../../logging/bridge';
import { createObservedFetch } from '../../request-logging';
import { waitFor } from '../../request-logging/test-support';
import { attributeName, createRequestTraceRecorder, getTraceRuntime } from '../../request-tracing';
import { toExportableSpan } from '../../request-tracing/otel-export/safe-span';
import type { ProviderRouteSource } from '../../runtime';
import { createUsageCapture } from '../../usage-capture';
import { createOpenAIResponsesRoutes } from '../openai-responses';

Object.assign(globalThis, { __AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__: openAIChatGPTClientId });
const { createOpenAIChatGPTPlugin, englishPresentationText } =
  await import('../../../../plugins/openai-chatgpt/src/plugin');

const sentinel = 'GUARDIAN_SENTINEL_7fbc4e';
const rationale = 'The action poses critical risk under the supplied policy.';
function answer(deny = false) {
  const selected: Record<string, string> = {
    risk_level: deny ? 'critical' : 'low',
    user_authorization: 'unknown',
    outcome: deny ? 'deny' : 'allow',
    reason: deny ? 'critical_risk' : 'low_risk',
  };
  return {
    id: sentinel,
    answers: Object.fromEntries(
      Object.entries(guardianQuestions()).map(([id, question]) => [
        id,
        {
          type: 'choice',
          choice: selected[id],
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((label) => [label, label === selected[id] ? 1 : 0]),
          ),
        },
      ]),
    ),
    usage: { input_tokens: 5, output_tokens: 1 },
  };
}
const originalBody = JSON.stringify({
  id: sentinel,
  object: 'response',
  status: 'completed',
  model: 'codex-auto-review',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"outcome":"allow"}' }] }],
  usage: { input_tokens: 10, output_tokens: 2 },
});

async function harness(
  options: {
    strategy?: 'systemOne' | 'systemOneReviewDenied';
    evaluate?: (request: Request) => Promise<Response>;
    original?: (request: Request) => Promise<Response>;
    target?: 'missing' | 'disabled';
    registerWrapper?: boolean;
  } = {},
) {
  const evaluationRequests: unknown[] = [];
  const apiReviewRequests: Request[] = [];
  const traces: TraceCompletion[] = [];
  const starts: unknown[] = [];
  const exported: unknown[] = [];
  const consoleDiagnostics: unknown[] = [];
  let source!: ProviderRouteSource;
  let active = 0;
  const clean = () => {
    const leaked = JSON.stringify({
      logs: route.logs,
      consoleDiagnostics,
      // Response ownership is operational state (R6), not an exported diagnostic.
      traces: traces.map(({ sessionState: _routing, ...diagnostic }) => diagnostic),
      starts,
      exported,
    });
    for (const privateText of [
      sentinel,
      'pending_action',
      'Planned action JSON:',
      rationale,
      'Human user/developer messages',
    ])
      expect(leaked).not.toContain(privateText);
  };
  const chatgpt = rawProvider({
    id: 'api-review',
    modelId: 'codex-auto-review',
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async (request) => {
      clean();
      apiReviewRequests.push(request);
      return options.original
        ? options.original(request)
        : new Response(originalBody, { headers: { 'content-type': 'application/json', 'x-request-id': sentinel } });
    },
  });
  const evaluator = rawProvider({
    id: 'evaluation',
    modelId: 'review',
    protocol: ProviderProtocol.TypeSafeSystemOne,
    invoke: async (request) => {
      clean();
      expect(request.headers.has('authorization')).toBe(false);
      expect(request.headers.has('x-api-key')).toBe(false);
      evaluationRequests.push(await request.clone().json());
      return createObservedFetch((async () =>
        options.evaluate ? options.evaluate(request) : Response.json(answer())) as typeof fetch)(request);
    },
  });
  const route = defineProviderRouteSource(
    [
      {
        ...chatgpt,
        provider: {
          ...chatgpt.provider,
          kind: ProviderKind.OAuth,
          alias: {},
          models: ['codex-auto-review'],
          upstreamMetadata: { 'codex-auto-review': { cost: { request: 0.1 } } },
          plugin: '@aio-proxy/plugin-openai-chatgpt',
        },
      },
      ...(options.target === 'missing'
        ? []
        : [
            {
              ...evaluator,
              provider: {
                ...evaluator.provider,
                enabled: options.target !== 'disabled',
                alias: {},
                models: ['review'],
                capabilityIndex: { review: new Set(['evaluation'] as const) },
                upstreamMetadata: { review: { cost: { request: 0.02 } } },
              },
            },
          ]),
    ],
    undefined,
    true,
  );
  const emit = (entry: unknown) => {
    route.logs.push(entry);
  };
  const logger = { debug: emit, info: emit, warn: emit, error: emit, child: () => logger };
  const snapshot = route.source.currentProviderSnapshot();
  const config = ConfigSchema.parse({
    plugins: [
      [
        '@aio-proxy/plugin-openai-chatgpt',
        {
          guardianStrategy: options.strategy ?? 'systemOne',
          guardianProviderId: 'evaluation',
          guardianModelId: 'review',
        },
      ],
    ],
    providers: {},
  });
  const pluginHost = createPluginRegistryHost();
  const staged = pluginHost.stage('@aio-proxy/plugin-openai-chatgpt', { builtIn: true });
  if (options.registerWrapper !== false) {
    await createOpenAIChatGPTPlugin(englishPresentationText).setup(staged.api, {
      guardianStrategy: options.strategy ?? 'systemOne',
      guardianProviderId: 'evaluation',
      guardianModelId: 'review',
    });
  }
  staged.seal();
  staged.commit();
  const leasedSnapshot = {
    ...snapshot,
    config,
    plugins: {
      registry: pluginHost.registry,
      plugins: new Map([['@aio-proxy/plugin-openai-chatgpt', { builtIn: true, state: { status: 'ready' } }]]),
    },
  };
  source = {
    ...route.source,
    logger: createServerLogSink(logger),
    usageCapture: createUsageCapture(),
    currentProviderSnapshot: () => ({
      ...leasedSnapshot,
    }),
    acquireProviderSnapshot: () => {
      active++;
      return {
        snapshot: leasedSnapshot,
        release: () => {
          active--;
        },
      };
    },
    preObservationCapturePolicy: async (request, _snapshot, maxBytes) => ({
      capturePayload: (await guardianPayloadHint(request, { maxBytes })) !== 'sensitive',
    }),
    requestRecorder: createRequestTraceRecorder({
      store: {
        startRoot: (value) => {
          starts.push(value);
        },
        prune() {},
        complete: (value) => {
          traces.push(value);
          return true;
        },
      },
    }),
  };
  const exporter = spyOn(getTraceRuntime().exporter, 'onEnd').mockImplementation((span) => {
    exported.push(toExportableSpan(span));
  });
  const consoleSink = spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    consoleDiagnostics.push(
      values.map((value) =>
        value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
      ),
    );
  });
  const body = await guardianRequest(syntheticGuardianInput).json();
  body.input[1].content[0].text += sentinel;
  body.stream = false;
  const app = createOpenAIResponsesRoutes(source);
  return {
    app,
    body,
    source,
    traces,
    exported,
    logs: route.logs,
    evaluationRequests,
    apiReviewRequests,
    clean,
    activeLeases: () => active,
    close: () => {
      exporter.mockRestore();
      consoleSink.mockRestore();
    },
    send: (signal?: AbortSignal) =>
      app.request('/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }),
  };
}

for (const stream of [false, true])
  for (const deny of [false, true])
    test(`real Responses route returns one ${deny ? 'deny' : 'allow'} decision, stream=${stream}`, async () => {
      const h = await harness({ evaluate: async () => Response.json(answer(deny)) });
      try {
        h.body.stream = stream;
        const response = await h.send();
        expect(response.status).toBe(200);
        const text = await response.text();
        const result = stream
          ? JSON.parse(text.trim().split('\n\n').at(-1)!.split('data: ')[1]!).response
          : JSON.parse(text);
        expect(result.output).toHaveLength(1);
        expect(JSON.parse(result.output[0].content[0].text).outcome).toBe(deny ? 'deny' : 'allow');
        if (stream) expect(text.match(/event: response.output_text.delta/g)).toHaveLength(1);
        expect(h.evaluationRequests).toHaveLength(1);
        expect(h.apiReviewRequests).toHaveLength(0);
        expect(h.evaluationRequests[0]).toMatchObject({
          model: 'review',
          state: { input: h.body.input, pending_action: JSON.parse(h.body.input.at(-1).content[3].text) },
        });
        await waitFor(() => h.traces.length === 2 && h.activeLeases() === 0);
        expect(h.traces.filter((trace) => trace.summary.usage !== undefined)).toHaveLength(1);
        const internal = h.traces.find((trace) => trace.summary.usage)!;
        expect(internal.summary.usage).toMatchObject({
          providerId: 'evaluation',
          inputTokens: 5,
          estimatedCostUsd: 0.02,
        });
        const parent = h.traces.find((trace) => !trace.summary.usage)!;
        expect(internal.spans.find((span) => span.spanId === internal.rootSpanId)?.links[0]?.traceId).toBe(
          parent.traceId,
        );
        expect(
          internal.spans.some((span) => span.attributes[attributeName.guardianParentRequestId] !== undefined),
        ).toBe(true);
        h.clean();
      } finally {
        h.close();
      }
    });

test('without a registered wrapper, the selected Responses transport runs directly', async () => {
  const h = await harness({ registerWrapper: false });
  try {
    expect((await h.send()).status).toBe(200);
    expect(h.evaluationRequests).toHaveLength(0);
    expect(h.apiReviewRequests).toHaveLength(1);
  } finally {
    h.close();
  }
});

for (const scenario of ['denial', 'malformed', 'non-2xx', 'error', 'retry'] as const)
  test(`real route keeps privacy and accounting across ${scenario} fallback`, async () => {
    let evaluations = 0;
    const h = await harness({
      strategy: 'systemOneReviewDenied',
      evaluate: async () => {
        evaluations++;
        if (scenario === 'error') throw Object.assign(new Error(sentinel), { code: sentinel });
        if (scenario === 'non-2xx') return new Response(sentinel, { status: 503 });
        return Response.json(
          scenario === 'malformed' ? { ...answer(), answers: {} } : answer(scenario !== 'retry' || evaluations === 1),
        );
      },
      ...(scenario === 'retry'
        ? {
            original: async () =>
              Response.json({ error: { code: 'invalid_encrypted_content', message: sentinel } }, { status: 400 }),
          }
        : {}),
    });
    try {
      const response = await h.send();
      expect(response.status).toBe(200);
      const text = await response.text();
      if (scenario !== 'retry') expect(text).toBe(originalBody);
      else expect(JSON.parse(JSON.parse(text).output_text)).toEqual({ outcome: 'allow' });
      expect(h.apiReviewRequests).toHaveLength(1);
      expect(h.evaluationRequests).toHaveLength(scenario === 'retry' ? 2 : 1);
      await waitFor(() => h.traces.length === evaluations + 1 && h.activeLeases() === 0);
      const rows = h.traces.flatMap((trace) => (trace.summary.usage ? [trace.summary.usage] : []));
      expect(rows.filter((row) => row.providerId === 'api-review')).toHaveLength(scenario === 'retry' ? 0 : 1);
      expect(rows.filter((row) => row.providerId === 'evaluation')).toHaveLength(
        ['error', 'non-2xx'].includes(scenario) ? 0 : evaluations,
      );
      expect(rows.reduce((sum, row) => sum + (row.estimatedCostUsd ?? 0), 0)).toBeCloseTo(
        (scenario === 'retry' ? 0 : 0.1) + (['error', 'non-2xx'].includes(scenario) ? 0 : evaluations * 0.02),
      );
      expect(h.exported.length).toBeGreaterThan(0);
      h.clean();
    } finally {
      h.close();
    }
  });

for (const target of ['missing', 'disabled'] as const)
  test(`saved ${target} Provider reports actionable safe IDs and falls back`, async () => {
    const h = await harness({ target });
    try {
      expect(await (await h.send()).text()).toBe(originalBody);
      expect(h.evaluationRequests).toHaveLength(0);
      expect(h.apiReviewRequests).toHaveLength(1);
      expect(h.logs).toContainEqual(
        expect.objectContaining({
          event: 'guardian.evaluation.unavailable',
          errorCode: 'target_unavailable',
          targetProviderId: 'evaluation',
          targetModelId: 'review',
        }),
      );
      h.clean();
    } finally {
      h.close();
    }
  });

test('non-Guardian Responses still records ordinary debug bodies', async () => {
  const h = await harness();
  try {
    delete h.body.client_metadata;
    h.body.input = 'ordinary-debug-capture';
    await (await h.send()).text();
    expect(h.evaluationRequests).toHaveLength(0);
    await waitFor(() => JSON.stringify(h.logs).includes('ordinary-debug-capture'));
  } finally {
    h.close();
  }
});

test('evaluation abort waits for deferred body cancellation before releasing its lease', async () => {
  const reading = Promise.withResolvers<void>();
  const cancelling = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const caller = new AbortController();
  const h = await harness({
    evaluate: async () =>
      new Response(
        new ReadableStream({
          pull() {
            reading.resolve();
          },
          cancel() {
            cancelling.resolve();
            return cancelled.promise;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
  try {
    const pending = h.send(caller.signal);
    await reading.promise;
    await Bun.sleep(0);
    caller.abort(new DOMException('Aborted', 'AbortError'));
    await cancelling.promise;
    await pending;
    await Bun.sleep(0);
    expect(h.apiReviewRequests).toHaveLength(0);
    expect(h.activeLeases()).toBe(1);
    cancelled.resolve();
    await waitFor(() => h.activeLeases() === 0);
    h.clean();
  } finally {
    cancelled.resolve();
    h.close();
  }
});

for (const gate of ['before-dispatch', 'before-fallback', 'after-fallback'] as const)
  test(`caller cancellation at ${gate} never starts a later original send`, async () => {
    const caller = new AbortController();
    const originalStarted = Promise.withResolvers<void>();
    let originalSignal: AbortSignal | undefined;
    const h = await harness({
      evaluate: async () => {
        if (gate === 'before-fallback') caller.abort(new DOMException('Aborted', 'AbortError'));
        return Response.json({ answers: {} });
      },
      original: async (request) => {
        originalSignal = request.signal;
        originalStarted.resolve();
        return new Promise((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }),
        );
      },
    });
    try {
      if (gate === 'before-dispatch') caller.abort(new DOMException('Aborted', 'AbortError'));
      const pending = h.send(caller.signal);
      if (gate === 'after-fallback') {
        await originalStarted.promise;
        caller.abort(new DOMException('Aborted', 'AbortError'));
      }
      const response = await pending;
      await response.text();
      expect(h.apiReviewRequests).toHaveLength(gate === 'after-fallback' ? 1 : 0);
      if (gate === 'after-fallback') expect(originalSignal?.aborted).toBe(true);
      if (gate === 'before-dispatch') expect(h.evaluationRequests).toHaveLength(0);
      await waitFor(() => h.activeLeases() === 0);
      h.clean();
    } finally {
      h.close();
    }
  });

test('timeout releases a non-returning transport and independently disposes its late response', async () => {
  const deadline = new AbortController();
  const started = Promise.withResolvers<void>();
  const late = Promise.withResolvers<Response>();
  const cancelling = Promise.withResolvers<void>();
  const disposed = Promise.withResolvers<void>();
  let cancellationFinished = false;
  const h = await harness({
    evaluate: () => {
      started.resolve();
      return late.promise;
    },
  });
  const timer = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  try {
    const pending = h.send();
    await started.promise;
    deadline.abort(new DOMException('Timeout', 'TimeoutError'));
    expect(await (await pending).text()).toBe(originalBody);
    expect(h.apiReviewRequests).toHaveLength(1);
    await waitFor(() => h.activeLeases() === 0);
    late.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(answer())));
          },
          cancel() {
            cancelling.resolve();
            return disposed.promise.then(() => {
              cancellationFinished = true;
            });
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    await cancelling.promise;
    expect(h.activeLeases()).toBe(0);
    disposed.resolve();
    await waitFor(() => cancellationFinished && h.activeLeases() === 0);
    expect(h.apiReviewRequests).toHaveLength(1);
    h.clean();
  } finally {
    disposed.resolve();
    timer.mockRestore();
    h.close();
  }
});
