import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { aioHome } from '@aio-proxy/core';
import { createTraceStore, openDb } from '@aio-proxy/core/db';
import type { DashboardTraceSpan } from '@aio-proxy/types';
import { YAML } from 'bun';

import { createServer, createServerTestHome } from '#server-test-lifecycle';

import { recorded } from '../../../__tests__/trace-recording.test-support';
import { attributeName, spanName } from '../../request-tracing';

/**
 * Routing tests that start from REAL config YAML rather than hand-built runtime
 * providers. The dispatch-matrix tests one layer down cannot see a provider that
 * is silently never selected, because they construct the capability index they
 * then assert on. Everything here goes through `parseRuntimeConfig` and
 * `materializeProviders`, so a provider that config makes unroutable fails here
 * and nowhere else.
 */

const SLUG = 'jev-latest';
const NOUL = { q: { type: 'noul', instructions: 'Did it answer in French?' } } as const;
const CHOICE = { c: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, tech: null } } } as const;

// ── Upstream ──────────────────────────────────────────────────────────────────

type UpstreamCall = {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly headers: Headers;
  readonly body: string;
};

type Upstream = {
  readonly calls: readonly UpstreamCall[];
  readonly origin: string;
};

const runningUpstreams: Bun.Server[] = [];
afterEach(() => {
  for (const server of runningUpstreams.splice(0)) server.stop(true);
});

function startUpstream(handler: (call: UpstreamCall) => Response | Promise<Response>): Upstream {
  const calls: UpstreamCall[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const call: UpstreamCall = {
        method: request.method,
        path: url.pathname,
        search: url.search,
        headers: request.headers,
        body: await request.text(),
      };
      calls.push(call);
      return await handler(call);
    },
  });
  runningUpstreams.push(server);
  return { calls, origin: `http://127.0.0.1:${server.port}` };
}

// ── The @ai-sdk/gateway stand-in ──────────────────────────────────────────────

/**
 * A real npm package on disk, loaded by the real `loadAiSdkProvider` out of the
 * npm package cache under the test home.
 *
 * The published `@ai-sdk/gateway` resolves no evaluation model at all, so the
 * documented Gateway-backup configuration cannot be exercised against it. What
 * must stay real is everything the routing defect lives in: the package is
 * unclassified, so nothing static can grant it evaluation, and the verdict has
 * to come from an actual load and probe. Only the package contents are a
 * fixture; the loader, the probe, the capability grant, and
 * `experimental_evaluate` are production code.
 *
 * `doEvaluate` forwards to `options.baseURL`, so each test drives the convert
 * answer over HTTP the same way it drives a raw one, and a convert attempt is
 * visible in the upstream call log.
 */
const GATEWAY_PACKAGE = `export function createGateway(options = {}) {
  const call = options.fetch ?? globalThis.fetch;
  return Object.assign(() => undefined, {
    evaluationModel: (modelId) => ({
      specificationVersion: 'v4',
      provider: 'gateway',
      modelId,
      supportedQuestionTypes: ['boolean', 'choice', 'score'],
      async doEvaluate({ state, questions }) {
        const response = await call(options.baseURL + '/evaluate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ modelId, state, questions }),
        });
        const payload = await response.json();
        return { answers: payload.answers, usage: payload.usage, warnings: [] };
      },
    }),
  });
}
`;

beforeAll(() => {
  installFakePackage('@ai-sdk/gateway', GATEWAY_PACKAGE);
  installFakePackage('@aio-test/no-evaluation', NO_EVALUATION_PACKAGE);
});

/**
 * A package that loads cleanly and resolves no evaluation model. The companion
 * negative to the cold-Gateway case: admitting an attached-but-unprobed
 * transport must not turn into serving a package that cannot evaluate, so this
 * one has to be skipped once the probe answers.
 */
const NO_EVALUATION_PACKAGE = `export function createThing(options = {}) {
  return Object.assign(() => undefined, { languageModel: () => undefined });
}
`;

function installFakePackage(name: string, source: string): void {
  // The layout `findInstalledNpmPackage` reads: <home>/packages/<encoded>/node_modules/<name>.
  const directory = join(aioHome(), 'packages', encodeURIComponent(name), 'node_modules', ...name.split('/'));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '4.0.6', main: 'index.mjs' }));
  writeFileSync(join(directory, 'index.mjs'), source);
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

type Scenario = {
  readonly app: Awaited<ReturnType<typeof createServer>>;
  readonly home: string;
  readonly upstream: Upstream;
};

async function scenario(options: {
  readonly config: (origin: string) => string;
  readonly upstream: (call: UpstreamCall) => Response | Promise<Response>;
}): Promise<Scenario> {
  const upstream = startUpstream(options.upstream);
  const home = createServerTestHome();
  // YAML text through the authoring parser, exactly as a user's config.yml
  // arrives: `createServer` hands it to `parseRuntimeConfig` itself.
  const app = await createServer({ config: YAML.parse(options.config(upstream.origin)), dbHome: home });
  return { app, home, upstream };
}

const evaluate = (payload: Record<string, unknown>, headers: Record<string, string> = {}): RequestInit => ({
  body: JSON.stringify(payload),
  headers: { 'content-type': 'application/json', ...headers },
  method: 'POST',
});

const systemOne = (questions: unknown = NOUL, overrides: Record<string, unknown> = {}) => ({
  model: SLUG,
  state: 'the assistant replied in French',
  questions,
  ...overrides,
});

// ── Config fixtures ───────────────────────────────────────────────────────────

/** The pair the README documents: a direct System One origin with a Gateway backup. */
const DIRECT_AND_GATEWAY = (origin: string) => `
providers:
  typesafe-direct:
    kind: api
    protocol: typesafe-systemone
    baseURL: ${origin}
    apiKey: direct-key
    models: [${SLUG}]
    priority: 10
  vercel-gateway:
    kind: ai-sdk
    packageName: '@ai-sdk/gateway'
    options:
      baseURL: ${origin}/gateway
    alias:
      ${SLUG}: typesafe-ai/jev
    priority: 0
`;

const GATEWAY_ONLY = (origin: string) => `
providers:
  vercel-gateway:
    kind: ai-sdk
    packageName: '@ai-sdk/gateway'
    options:
      baseURL: ${origin}/gateway
    alias:
      ${SLUG}: typesafe-ai/jev
`;

/**
 * An `openai-response` primary plus the Gateway backup. `@ai-sdk/openai` really
 * does resolve an evaluation model, so the first leg converts through the
 * published adapter against the fake upstream rather than through a double.
 */
const OPENAI_AND_GATEWAY = (origin: string) => `
providers:
  openai-judge:
    kind: api
    protocol: openai-response
    baseURL: ${origin}/openai/v1
    apiKey: judge-key
    models: [${SLUG}]
    priority: 10
  vercel-gateway:
    kind: ai-sdk
    packageName: '@ai-sdk/gateway'
    options:
      baseURL: ${origin}/gateway
    alias:
      ${SLUG}: typesafe-ai/jev
    priority: 0
`;

/** `openai-compatible` alone: no System One endpoint, and its package resolves no
 *  evaluation model, so this provider can never serve an evaluation. */
const COMPATIBLE_ONLY = (origin: string) => `
providers:
  compat:
    kind: api
    protocol: openai-compatible
    baseURL: ${origin}
    apiKey: compat-key
    models: [${SLUG}]
`;

/** The same provider with System One added as an extra endpoint: chat stays on the
 *  primary origin, evaluation is served by raw on the extra one. The legacy pair
 *  forwards the inbound path verbatim, while an `endpoints` entry appends the
 *  operation to its own base path - hence `/v1/chat/completions` against
 *  `/one/systemone`. */
const COMPATIBLE_WITH_SYSTEM_ONE = (origin: string) => `
providers:
  compat:
    kind: api
    protocol: openai-compatible
    baseURL: ${origin}
    apiKey: compat-key
    endpoints:
      - protocol: typesafe-systemone
        baseURL: ${origin}/one
    models: [${SLUG}]
`;

const GATEWAY_ANSWER = {
  answers: { q: { type: 'boolean', probability: 0.61 } },
  usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
};

/** A System One origin on its own, for the raw-passthrough fidelity cases. */
const DIRECT_ONLY = (origin: string) => `
providers:
  typesafe-direct:
    kind: api
    protocol: typesafe-systemone
    baseURL: ${origin}
    apiKey: direct-key
    models: [${SLUG}]
`;

/** `@ai-sdk/typesafe-ai` is genuinely not installed here, which is what makes it
 *  the honest fixture for a load failure. The classifier still pins the package to
 *  System One, so the slug is evaluation-only and never joins the chat pool. */
const TYPESAFE_SDK_ONLY = () => `
providers:
  typesafe-sdk:
    kind: ai-sdk
    packageName: '@ai-sdk/typesafe-ai'
    models: [${SLUG}]
`;

const TYPESAFE_SDK_AND_GATEWAY = (origin: string) => `
providers:
  typesafe-sdk:
    kind: ai-sdk
    packageName: '@ai-sdk/typesafe-ai'
    models: [${SLUG}]
    priority: 10
  vercel-gateway:
    kind: ai-sdk
    packageName: '@ai-sdk/gateway'
    options:
      baseURL: ${origin}/gateway
    alias:
      ${SLUG}: typesafe-ai/jev
    priority: 0
`;

/**
 * Deliberately non-canonical: the indentation is irregular, the keys are not in
 * alphabetical order, and `aio_sentinel` is a field the proxy knows nothing
 * about. A field-level assertion would pass against an implementation that
 * parsed this and re-serialized it; only the exact text catches that.
 */
const EXACT_UPSTREAM_TEXT = `{
     "answers": {
    "c" : {"type":"choice","choice":"billing","probabilities":{"tech":0.2,"billing":0.8}}
   },
  "model":"judge-9",
      "aio_sentinel": "preserve-me"
}`;

/** A package with no evaluation resolver in front of a working backup. */
const NO_EVALUATION_AND_GATEWAY = (origin: string) => `
providers:
  plain-sdk:
    kind: ai-sdk
    packageName: '@aio-test/no-evaluation'
    models: [${SLUG}]
    priority: 10
  vercel-gateway:
    kind: ai-sdk
    packageName: '@ai-sdk/gateway'
    options:
      baseURL: ${origin}/gateway
    alias:
      ${SLUG}: typesafe-ai/jev
    priority: 0
`;

// ── Trace reading ─────────────────────────────────────────────────────────────

/**
 * The attempt spans of the single recorded request, in attempt order.
 *
 * `recorded()` next door projects spans into the legacy row shape and drops
 * `aio_proxy.transport`, which is the field these tests exist for, so they read
 * the spans directly. The poll is `recorded()`'s: a successful request settles
 * its trace asynchronously, and a real server exposes no flush hook.
 */
async function attemptSpans(home: string): Promise<readonly DashboardTraceSpan[]> {
  const { requests } = await recorded(home);
  const requestId = requests[0]?.requestId;
  const handle = openDb({ home });
  try {
    const store = createTraceStore(handle.db);
    const root = store.list({ pageSize: 10 }).items.find((item) => item.requestId === requestId);
    // Attempt spans are named `{operation} {model}` now, so the old
    // `aio_proxy.provider.attempt` constant is no longer a key. Index is the
    // stable marker; token-count's skipped-candidate spans also carry it.
    return (root === undefined ? [] : (store.find(root.traceId)?.spans ?? []))
      .filter(
        (span) => span.attributes[attributeName.attemptIndex] !== undefined && span.name !== spanName.candidateSkipped,
      )
      .sort(
        (a, b) => Number(a.attributes[attributeName.attemptIndex]) - Number(b.attributes[attributeName.attemptIndex]),
      );
  } finally {
    handle.close();
  }
}

const attemptFacts = (span: DashboardTraceSpan) => ({
  providerId: span.attributes[attributeName.providerId],
  transport: span.attributes[attributeName.transport],
  targetProtocol: span.attributes[attributeName.targetProtocol],
  statusCode: span.attributes[attributeName.httpStatusCode],
  errorCode: span.errorCode,
  outcome: span.terminationReason ?? 'success',
});

/** The OpenAI Responses envelope the evaluation model reads its JSON out of. */
const openAIResponse = (answers: Record<string, unknown>) =>
  Response.json({
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    model: 'gpt-judge',
    status: 'completed',
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(answers), annotations: [] }],
      },
    ],
    usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
  });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('evaluation routing from real config', () => {
  test('routes the documented direct-primary / Gateway-backup pair and fails over on 529', async () => {
    const { app, upstream } = await scenario({
      config: DIRECT_AND_GATEWAY,
      upstream: (call) =>
        call.path === '/v1/systemone'
          ? Response.json({ message: 'overloaded' }, { status: 529 })
          : Response.json(GATEWAY_ANSWER),
    });

    const response = await app.request('/v1/systemone', evaluate(systemOne()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      model: SLUG,
      answers: { q: { type: 'noul', noul: 0.61 } },
      usage: { input_tokens: 7, output_tokens: 2 },
    });
    // Both legs ran, in priority order. Without the direct call the failover was
    // never exercised; without the gateway call the backup was never selected.
    expect(upstream.calls.map((call) => call.path)).toEqual(['/v1/systemone', '/gateway/evaluate']);
  });

  test('selects a cold candidate on the first evaluation request of the process', async () => {
    const { app, upstream } = await scenario({
      config: GATEWAY_ONLY,
      upstream: () => Response.json(GATEWAY_ANSWER),
    });

    const response = await app.request('/v1/systemone', evaluate(systemOne()));

    // Nothing has loaded the package yet, so "not yet probed" is the only thing
    // the capability index can know. Reading that as unsupported filters the
    // provider out and answers 501 instead.
    expect(response.status).toBe(200);
    expect(upstream.calls.map((call) => call.path)).toEqual(['/gateway/evaluate']);
  });

  test('selects an api openai-response provider for an all-noul request', async () => {
    const { app, upstream } = await scenario({
      config: OPENAI_AND_GATEWAY,
      upstream: () => openAIResponse({ q0: 0.93 }),
    });

    const response = await app.request('/v1/systemone', evaluate(systemOne()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      model: SLUG,
      answers: { q: { type: 'noul', noul: 0.93 } },
      usage: { input_tokens: 11, output_tokens: 3 },
    });
    // Converted through the primary's own package; the backup was never reached.
    expect(upstream.calls.map((call) => call.path)).toEqual(['/openai/v1/responses']);
  });

  test('501s and falls back when that same provider gets a choice question', async () => {
    const { app, upstream } = await scenario({
      config: OPENAI_AND_GATEWAY,
      upstream: (call) =>
        call.path === '/openai/v1/responses'
          ? openAIResponse({ q0: 'c0' })
          : Response.json({
              answers: { c: { type: 'choice', choice: 'billing', probabilities: { billing: 0.8, tech: 0.2 } } },
            }),
    });

    const response = await app.request('/v1/systemone', evaluate(systemOne(CHOICE)));

    // The OpenAI adapter answers a choice without a distribution, which System One
    // requires, so egress refuses that candidate and the loop continues. A backup
    // whose answer carries `probabilities` then serves the request.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      model: SLUG,
      answers: { c: { type: 'choice', choice: 'billing', probabilities: { billing: 0.8, tech: 0.2 } } },
    });
    expect(upstream.calls.map((call) => call.path)).toEqual(['/openai/v1/responses', '/gateway/evaluate']);
  });

  test('does not select openai-compatible with no extra endpoint', async () => {
    const { app, upstream } = await scenario({
      config: COMPATIBLE_ONLY,
      upstream: () => Response.json({ unexpected: true }),
    });

    const response = await app.request('/v1/systemone', evaluate(systemOne()));

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error_type: 'not_supported_error' });
    // Never selected, rather than selected and then failing upstream.
    expect(upstream.calls).toEqual([]);
  });

  test('selects openai-compatible with an extra typesafe-systemone endpoint, via raw', async () => {
    const { app, upstream } = await scenario({
      config: COMPATIBLE_WITH_SYSTEM_ONE,
      upstream: (call) =>
        call.path === '/one/systemone'
          ? Response.json({ model: 'judge', answers: { q: { type: 'noul', noul: 0.4 } } })
          : Response.json({ id: 'chat', choices: [] }),
    });

    const evaluation = await app.request('/v1/systemone', evaluate(systemOne()));
    const chat = await app.request(
      '/v1/chat/completions',
      evaluate({ model: SLUG, messages: [{ role: 'user', content: 'hi' }] }),
    );

    expect(evaluation.status).toBe(200);
    expect(chat.status).toBe(200);
    // One provider, two origins: System One on the extra endpoint and chat on the
    // primary. The extra endpoint must grant evaluation without disturbing
    // language routing.
    expect(upstream.calls.map((call) => call.path)).toEqual(['/one/systemone', '/v1/chat/completions']);
  });

  test('keeps a slug served only by @ai-sdk/typesafe-ai out of the chat pool', async () => {
    const { app, upstream } = await scenario({
      config: TYPESAFE_SDK_ONLY,
      upstream: () => Response.json({ unexpected: true }),
    });

    const response = await app.request(
      '/v1/chat/completions',
      evaluate({ model: SLUG, messages: [{ role: 'user', content: 'hi' }] }),
    );

    expect(response.status).toBe(501);
    expect(upstream.calls).toEqual([]);
  });

  test('surfaces a load failure as a candidate failure, not a router miss', async () => {
    const alone = await scenario({
      config: TYPESAFE_SDK_ONLY,
      upstream: () => Response.json({ unexpected: true }),
    });
    const soloResponse = await alone.app.request('/v1/systemone', evaluate(systemOne()));

    // A package that cannot be loaded is this candidate's own failure. Reporting
    // it as an unknown model would blame config for a model the user did
    // configure, and throwing at startup would take a healthy process down.
    expect(soloResponse.status).toBe(501);
    expect(await soloResponse.json()).toEqual({
      message: 'Unsupported: evaluation_discovery',
      error_type: 'not_supported_error',
    });

    const withBackup = await scenario({
      config: TYPESAFE_SDK_AND_GATEWAY,
      upstream: () => Response.json(GATEWAY_ANSWER),
    });
    const response = await withBackup.app.request('/v1/systemone', evaluate(systemOne()));

    // And it falls back from its own position rather than ending the request.
    expect(response.status).toBe(200);
    expect(withBackup.upstream.calls.map((call) => call.path)).toEqual(['/gateway/evaluate']);
  });

  test('echoes the requested public slug on convert under an alias', async () => {
    const { app, upstream } = await scenario({
      config: GATEWAY_ONLY,
      upstream: () => Response.json(GATEWAY_ANSWER),
    });

    const response = await app.request('/v1/systemone', evaluate(systemOne()));

    // The client asked for `jev-latest` and must be answered with it, while the
    // alias target is what reaches the package.
    expect(await response.json()).toMatchObject({ model: SLUG });
    expect(JSON.parse(upstream.calls[0]?.body ?? 'null')).toMatchObject({ modelId: 'typesafe-ai/jev' });
  });

  test('ignores session affinity and response ownership', async () => {
    let systemOneCalls = 0;
    const { app, upstream } = await scenario({
      config: DIRECT_AND_GATEWAY,
      upstream: (call) => {
        if (call.path !== '/v1/systemone') return Response.json(GATEWAY_ANSWER);
        systemOneCalls += 1;
        return systemOneCalls === 1
          ? Response.json({ message: 'overloaded' }, { status: 529 })
          : Response.json({ model: 'direct', answers: { q: { type: 'noul', noul: 0.1 } } });
      },
    });

    const sticky = { session_id: 'session-1', 'x-conversation-id': 'conversation-1' };
    const first = await app.request('/v1/systemone', evaluate(systemOne(), sticky));
    const second = await app.request(
      '/v1/systemone',
      evaluate(systemOne(NOUL, { previous_response_id: 'resp_1' }), sticky),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // The first request ended on the backup. If evaluation established affinity
    // or committed response ownership, the second would be pinned there; it must
    // go back to the priority-10 primary, which is now healthy.
    expect(upstream.calls.map((call) => call.path)).toEqual(['/v1/systemone', '/gateway/evaluate', '/v1/systemone']);
    expect(await second.json()).toMatchObject({ answers: { q: { type: 'noul', noul: 0.1 } } });
  });
});

describe('raw passthrough fidelity', () => {
  test('returns the upstream body byte-for-byte on raw', async () => {
    const { app } = await scenario({
      config: DIRECT_ONLY,
      upstream: () => new Response(EXACT_UPSTREAM_TEXT, { headers: { 'content-type': 'application/json' } }),
    });

    const response = await app.request('/v1/systemone', evaluate(systemOne(CHOICE)));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(EXACT_UPSTREAM_TEXT);
  });

  test('forwards a raw 200 whose choice answer has no probabilities, unchanged', async () => {
    const body = { model: 'judge-9', answers: { c: { type: 'choice', choice: 'billing' } } };
    const { app } = await scenario({
      config: DIRECT_ONLY,
      upstream: () => Response.json(body),
    });

    const response = await app.request('/v1/systemone', evaluate(systemOne(CHOICE)));

    // The convert path refuses a distribution-less choice answer because it is the
    // one building the envelope. Raw builds nothing, so that rule must not reach
    // it: the proxy is not System One's validator.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
  });

  test('omits model on raw when the upstream omitted it', async () => {
    const { app } = await scenario({
      config: DIRECT_ONLY,
      upstream: () => Response.json({ answers: { q: { type: 'noul', noul: 0.2 } } }),
    });

    const response = await app.request('/v1/systemone', evaluate(systemOne()));

    // Convert always writes `model`; raw must not synthesize it to match.
    expect(await response.json()).toEqual({ answers: { q: { type: 'noul', noul: 0.2 } } });
  });

  test('forwards a raw HTML error body unchanged', async () => {
    const html = '<html><body><h1>502 Bad Gateway</h1></body></html>';
    const { app } = await scenario({
      config: DIRECT_ONLY,
      upstream: () => new Response(html, { status: 502, headers: { 'content-type': 'text/html' } }),
    });

    const response = await app.request('/v1/systemone', evaluate(systemOne()));

    // An upstream that answers HTML is exactly when a proxy is tempted to
    // substitute its own JSON error and hide what actually happened.
    expect(response.status).toBe(502);
    expect(await response.text()).toBe(html);
  });
});

describe('evaluation traces', () => {
  test('records transport=raw and targetProtocol=typesafe-systemone on the raw path', async () => {
    const { app, home } = await scenario({
      config: DIRECT_ONLY,
      upstream: () => Response.json({ model: 'judge', answers: { q: { type: 'noul', noul: 0.3 } } }),
    });

    // The body has to be drained before the trace settles: passthrough usage
    // capture completes when the response stream ends.
    await (await app.request('/v1/systemone', evaluate(systemOne()))).text();

    expect((await attemptSpans(home)).map(attemptFacts)).toEqual([
      {
        providerId: 'typesafe-direct',
        transport: 'raw',
        targetProtocol: 'typesafe-systemone',
        statusCode: 200,
        errorCode: undefined,
        outcome: 'success',
      },
    ]);
  });

  test('records transport=ai_sdk and no targetProtocol on the convert path', async () => {
    const { app, home } = await scenario({
      config: GATEWAY_ONLY,
      upstream: () => Response.json(GATEWAY_ANSWER),
    });

    await app.request('/v1/systemone', evaluate(systemOne()));

    // Convert speaks no vendor wire protocol, so naming one would misreport where
    // the request went.
    expect((await attemptSpans(home)).map(attemptFacts)).toEqual([
      {
        providerId: 'vercel-gateway',
        transport: 'ai_sdk',
        targetProtocol: undefined,
        statusCode: undefined,
        errorCode: undefined,
        outcome: 'success',
      },
    ]);
  });

  test('records an unsupported convert candidate as a 501 attempt, then the fallback', async () => {
    const { app, home, upstream } = await scenario({
      config: NO_EVALUATION_AND_GATEWAY,
      upstream: () => Response.json(GATEWAY_ANSWER),
    });

    const response = await app.request('/v1/systemone', evaluate(systemOne()));

    expect(response.status).toBe(200);
    // The package loaded and resolved nothing, so this candidate is admitted and
    // then declines. The trace carries `unsupported_feature` and 501; the
    // `evaluation_convert` feature name reaches the caller in the response body of
    // a request with no healthy candidate left, not into the span.
    expect((await attemptSpans(home)).map(attemptFacts)).toEqual([
      {
        providerId: 'plain-sdk',
        transport: undefined,
        targetProtocol: undefined,
        statusCode: 501,
        errorCode: 'unsupported_feature',
        outcome: 'failure',
      },
      {
        providerId: 'vercel-gateway',
        transport: 'ai_sdk',
        targetProtocol: undefined,
        statusCode: undefined,
        errorCode: undefined,
        outcome: 'success',
      },
    ]);
    // Admission is not support: nothing was sent upstream on the declining leg.
    expect(upstream.calls.map((call) => call.path)).toEqual(['/gateway/evaluate']);
  });

  test('records exactly two attempts for a raw 529 followed by a successful convert', async () => {
    const { app, home } = await scenario({
      config: DIRECT_AND_GATEWAY,
      upstream: (call) =>
        call.path === '/v1/systemone'
          ? Response.json({ message: 'overloaded' }, { status: 529 })
          : Response.json(GATEWAY_ANSWER),
    });

    await (await app.request('/v1/systemone', evaluate(systemOne()))).text();

    // Two candidates, two attempts. A third would mean the AI SDK retried
    // underneath the pipeline, which hides attempts from traces and doubles the
    // candidate's time budget - `maxRetries: 0` is what prevents it.
    const spans = await attemptSpans(home);
    expect(spans).toHaveLength(2);
    expect(spans.map(attemptFacts)).toEqual([
      expect.objectContaining({ providerId: 'typesafe-direct', transport: 'raw', statusCode: 529 }),
      expect.objectContaining({ providerId: 'vercel-gateway', transport: 'ai_sdk', outcome: 'success' }),
    ]);
  });
});
