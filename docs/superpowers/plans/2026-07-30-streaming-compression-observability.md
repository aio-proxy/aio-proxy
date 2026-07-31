# Streaming Compression and Attempt Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make managed OpenAI upstream streams default to identity encoding and persist one trustworthy set of aggregate transport/semantic latency measurements on every provider attempt.

**Architecture:** A server-only attempt observation collector is created beside `CandidateSlot.startedAt`, follows the existing attempt AsyncLocalStorage boundary into injected fetches, and is updated by the existing raw/model usage capture streams. The OpenAI wrapper receives an explicit upstream-stream hint, keeps controlled decoding for streams, and leaves true non-stream requests to Bun; the attempt emitter snapshots the collector exactly once before every attempt span ends.

**Tech Stack:** Bun, TypeScript, Web `Request`/`Response`/`ReadableStream`, `eventsource-parser`, OpenTelemetry spans, Bun test.

## Global Constraints

- Implement only `docs/superpowers/specs/2026-07-30-streaming-compression-observability-design.md`; model metadata remains in GitHub issue #96.
- Use `rtk` as the prefix for every shell command and `apply_patch` for edits.
- Follow strict red-green TDD: add one behavior test, run it and observe the expected failure, then write the minimum implementation.
- Add no dependency, provider configuration field, database column, migration, Dashboard list field, per-frame event, per-frame log, or response-body persistence.
- `RawTransport.invoke` is backward compatible and accepts the optional third argument `invoke(request, logicalContext?, { upstreamStream })`.
- The stream fact comes from the already parsed `adapter.wantsStream()` result; do not clone or parse a request body to infer it.
- Header priority is final provider request `Accept-Encoding`, then plugin transport `acceptEncoding`, then streaming default `identity`; a true non-stream request sets no default and passes no `decompress` override.
- Generic API and built-in openai-chatgpt managed raw transports remove the inbound client `Accept-Encoding` before provider/plugin policy is applied.
- Explicitly compressed streams retain `decompress: false`, the controlled decoder, backpressure, protocol-terminal cancellation, and error propagation.
- Observations are attempt-local, use `CandidateSlot.startedAt`, round non-negative milliseconds, omit missing values, and retain semantic content metrics when raw transport observation is `unavailable` or `ambiguous`.
- The content-gap histogram uses exactly `0..250` by 1 ms, `260..1000` by 10 ms, `1100..10000` by 100 ms, `11000..60000` by 1000 ms, and one `>60000` overflow bucket whose actual maximum is retained. Each gap enters the first bucket whose upper bound is greater than or equal to it, so `(250, 260]` maps to `260`.
- Never use `ReadableStream.tee()` for metrics; observers pull one source reader and enqueue the same chunk unchanged.
- Baseline exception approved by the user: root `CHANGELOG.md` currently fails `oxfmt --check`, and `@aio-proxy/plugin-xai-grok#test:artifact` expects `0.0.0` while the build emits `0.0.1`. Do not modify either unrelated area; final verification must show no new failure beyond those two.
- Every commit includes `Co-authored-by: Codex <noreply@openai.com>`.

---

### Task 1: Attempt-local aggregate collector

**Files:**
- Create: `packages/server/src/response-observation/index.ts`
- Create: `packages/server/src/response-observation/response-observation.ts`
- Test: `packages/server/src/response-observation/response-observation.test.ts`

**Interfaces:**
- Consumes: `startedAt: number`, optional monotonic `now: () => number`, observed `Response` headers, source-read byte/frame counts, decoded SSE event notifications, and text/reasoning content notifications.
- Produces: `AttemptResponseObservation`, `AttemptResponseSnapshot`, `createAttemptResponseObservation({ startedAt, now? })`, `withAttemptResponseObservation(observation, operation)`, and `currentAttemptResponseObservation()`.

- [ ] **Step 1: Write failing collector tests**

Cover exact omission/zero semantics, encoding normalization, one-response timings, fixed-bucket p95 boundaries, overflow, `unavailable`, and `ambiguous`:

```ts
import { describe, expect, test } from 'bun:test';

import { createAttemptResponseObservation } from '.';

test('records one controlled SSE response against the candidate baseline', () => {
  let now = 1_000;
  const observation = createAttemptResponseObservation({ startedAt: 1_000, now: () => now });
  observation.markTransportUnavailable();
  observation.observeFetchStart();
  now = 1_012;
  const body = observation.observeResponse(
    new Response('data: {}\n\n', {
      headers: { 'content-type': 'text/event-stream', 'content-encoding': 'identity' },
    }),
    { controlledStream: true },
  );
  now = 1_018;
  body?.observeRead(10, 2);
  now = 1_021;
  observation.observeSseEvent();
  now = 1_030;
  observation.observeContent();
  now = 1_041;
  observation.observeContent();

  expect(observation.snapshot()).toEqual({
    transportObservation: 'sse',
    upstreamHeadersMs: 12,
    firstUpstreamByteMs: 18,
    firstSseEventMs: 21,
    contentGapP95Ms: 11,
    maxSseFramesPerRead: 2,
    contentEncoding: 'identity',
  });
});

test('omits unobserved values instead of writing zero', () => {
  const observation = createAttemptResponseObservation({ startedAt: 5, now: () => 5 });
  expect(observation.snapshot()).toEqual({});
  observation.markTransportUnavailable();
  expect(observation.snapshot()).toEqual({ transportObservation: 'unavailable' });
});

test('keeps content gaps local to each response after two responses', () => {
  let now = 0;
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => now });
  observation.observeFetchStart();
  observation.observeResponse(new Response('one'), { controlledStream: false });
  observation.observeContent(10);
  observation.observeContent(20);
  observation.observeFetchStart();
  observation.observeResponse(new Response('two'), { controlledStream: false });
  observation.observeContent(100);
  observation.observeContent(105);
  expect(observation.snapshot()).toEqual({ transportObservation: 'ambiguous', contentGapP95Ms: 10 });
});
```

Add table-driven gaps at `0`, `250`, `250.1`, `260`, `1000`, `1000.1`, `10000`, `10000.1`, `60000`, and `60000.1`; assert nearest-rank `ceil(count * 0.95)` and the actual overflow maximum.

```ts
test.each([
  [0, 0],
  [250, 250],
  [250.1, 260],
  [260, 260],
  [1_000, 1_000],
  [1_000.1, 1_100],
  [10_000, 10_000],
  [10_000.1, 11_000],
  [60_000, 60_000],
  [60_000.1, 60_000],
] as const)('places a %dms gap in the %dms upper-bound bucket', (gap, expected) => {
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 0 });
  observation.observeContent(0);
  observation.observeContent(gap);
  expect(observation.snapshot().contentGapP95Ms).toBe(expected);
});

test('uses nearest-rank p95 and the rounded actual maximum in overflow', () => {
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 0 });
  observation.observeContent(0);
  for (const at of [1, 2, 3, 4, 61_238.4, 123_584]) observation.observeContent(at);
  expect(observation.snapshot().contentGapP95Ms).toBe(62_346);
});
```

- [ ] **Step 2: Run the collector test and confirm red**

Run:

```bash
rtk bun test packages/server/src/response-observation/response-observation.test.ts
```

Expected: FAIL because `packages/server/src/response-observation/index.ts` does not exist.

- [ ] **Step 3: Implement the minimum collector and AsyncLocalStorage scope**

Use these public shapes and keep the histogram counts bounded:

```ts
export type TransportObservation = 'sse' | 'body' | 'unavailable' | 'ambiguous';

export type AttemptResponseSnapshot = {
  readonly transportObservation?: TransportObservation;
  readonly upstreamHeadersMs?: number;
  readonly firstUpstreamByteMs?: number;
  readonly firstSseEventMs?: number;
  readonly contentGapP95Ms?: number;
  readonly maxSseFramesPerRead?: number;
  readonly contentEncoding?: 'identity' | 'gzip' | 'deflate' | 'br' | 'zstd' | 'multiple' | 'other';
};

export type ResponseBodyObservation = {
  readonly observeRead: (byteLength: number, sseFrames: number) => void;
};

export type AttemptResponseObservation = {
  readonly markTransportUnavailable: () => void;
  readonly observeFetchStart: () => void;
  readonly observeResponse: (
    response: Response,
    options: { readonly controlledStream: boolean },
  ) => ResponseBodyObservation | undefined;
  readonly observeSseEvent: (at?: number) => void;
  readonly observeContent: (at?: number) => number;
  readonly snapshot: () => AttemptResponseSnapshot;
};
```

Store one `Uint32Array` for fixed bucket counts, `lastContentAt`, `gapCount`, and `overflowMax`; use a small binary search over fixed upper bounds. `observeFetchStart()` changes `unavailable` to a pending state so a fetch exception before headers leaves `transportObservation` absent. The second resolved `Response` makes the snapshot `ambiguous`, resets `lastContentAt` so inter-response idle time is not a content gap, and suppresses headers/byte/event/encoding/frame fields while retaining already accumulated response-local gaps.

Implement scope without coupling it to debug logging:

```ts
const storage = new AsyncLocalStorage<AttemptResponseObservation>();

export function withAttemptResponseObservation<T>(
  observation: AttemptResponseObservation,
  operation: () => T,
): T {
  return storage.run(observation, operation);
}

export function currentAttemptResponseObservation(): AttemptResponseObservation | undefined {
  return storage.getStore();
}
```

- [ ] **Step 4: Run collector tests and server type-aware lint**

Run:

```bash
rtk bun test packages/server/src/response-observation/response-observation.test.ts
rtk bunx oxlint --type-aware --type-check packages/server/src/response-observation
```

Expected: PASS.

- [ ] **Step 5: Commit the collector**

```bash
rtk git add packages/server/src/response-observation
rtk git commit -m "feat(server): add attempt response observation collector" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Raw and model semantic observations

**Files:**
- Modify: `packages/server/src/usage-capture/shared.ts`
- Modify: `packages/server/src/usage-capture/stream-capture.ts`
- Modify: `packages/server/src/usage-capture/passthrough-capture.ts`
- Modify: `packages/server/src/passthrough-usage/passthrough-usage.ts`
- Test: `packages/server/src/usage-capture/usage-capture.stream.test.ts`
- Test: `packages/server/src/usage-capture/usage-capture.passthrough.ttft.test.ts`

**Interfaces:**
- Consumes: `AttemptResponseObservation` from Task 1 through optional `observation` fields on `StreamUsageOptions` and `PassthroughUsageOptions`.
- Produces: one `observeSseEvent()` call per syntactically complete decoded SSE event and one `observeContent()` call per text/reasoning delta; existing `UsageCompletion.ttftMs` uses the timestamp returned by the first `observeContent()`.

- [ ] **Step 1: Write failing semantic callback tests**

Use an injected collector clock so no real sleep is required:

```ts
test('model capture records every content delta and ignores metadata and tool deltas', async () => {
  const times = [100, 105];
  const observation = createAttemptResponseObservation({ startedAt: 90, now: () => times.shift() ?? 105 });
  const stream = new ReadableStream<TextStreamPart<ToolSet>>({
    start(controller) {
      controller.enqueue({ type: 'tool-input-delta', id: 'tool-1', delta: '{' });
      controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'a' });
      controller.enqueue({ type: 'reasoning-delta', id: 'reasoning-1', text: 'b' });
      controller.close();
    },
  });
  const captured = createUsageCapture().stream({
    providerId: 'provider',
    modelId: 'model',
    startedAt: 90,
    observation,
    stream,
  });
  await drain(captured.value);
  expect(observation.snapshot().contentGapP95Ms).toBe(5);
});
```

Add a passthrough SSE test with lifecycle metadata, an Anthropic `input_json_delta`, two text/reasoning content events, and a terminal event. Assert the first SSE event is recorded, only the two generated-content events contribute a gap, and existing TTFT remains numeric.

- [ ] **Step 2: Run both focused tests and confirm red**

```bash
rtk bun test packages/server/src/usage-capture/usage-capture.stream.test.ts packages/server/src/usage-capture/usage-capture.passthrough.ttft.test.ts
```

Expected: FAIL because usage options do not accept `observation` and no callbacks update the collector.

- [ ] **Step 3: Wire semantic callbacks without changing stream demand**

Extend the two option types:

```ts
export type StreamUsageOptions = {
  readonly stream: ReadableStream<TextStreamPart<ToolSet>>;
  readonly providerId: string;
  readonly modelId: string;
  readonly requestedModelId?: string;
  readonly startedAt?: number;
  readonly observation?: AttemptResponseObservation;
};

export type PassthroughUsageOptions = {
  readonly response: Response;
  readonly protocol: ProviderProtocol;
  readonly providerId: string;
  readonly modelId: string;
  readonly requestedModelId?: string;
  readonly onResponseId?: (responseId: string) => void;
  readonly startedAt?: number;
  readonly observation?: AttemptResponseObservation;
};
```

In model capture, sample once and reuse that absolute timestamp for TTFT:

```ts
if (next.value.type === 'text-delta' || next.value.type === 'reasoning-delta') {
  const contentAt = observation?.observeContent() ?? performance.now();
  firstTokenAt ??= contentAt;
}
```

Add optional callbacks to `createPassthroughSseUsageObserver()` and invoke them inside `onEvent`:

```ts
export type PassthroughSseCallbacks = {
  readonly onEvent?: () => void;
  readonly onContent?: () => void;
};

onEvent(event) {
  safely(callbacks.onEvent);
  // existing parse, failure, usage, and response-id handling
  if (hasContentDelta(protocol, event.event, parsed)) {
    sawContent = true;
    safely(callbacks.onContent);
  }
}
```

`safely()` catches only observer callback failures; parser/usage behavior and byte passthrough remain unchanged. In passthrough capture, build these callbacks from `observation`, and reuse the returned content timestamp for existing TTFT.

- [ ] **Step 4: Run all usage-capture and passthrough-usage tests**

```bash
rtk bun test packages/server/src/usage-capture packages/server/src/passthrough-usage
```

Expected: PASS with unchanged cancellation, pricing, usage, and error outcomes.

- [ ] **Step 5: Commit semantic observation wiring**

```bash
rtk git add packages/server/src/usage-capture packages/server/src/passthrough-usage
rtk git commit -m "feat(server): observe attempt stream semantics" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Candidate ownership, stream hint, and terminal span snapshot

**Files:**
- Modify: `packages/plugin-sdk/src/runtime.ts`
- Modify: `packages/server/src/runtime.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/context.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/attempt.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/emit.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/raw.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/model.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/model-prepare.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/error.ts`
- Modify: `packages/server/src/request-tracing/semantic.ts`
- Modify: `packages/server/__tests__/pipeline-helpers/providers.ts`
- Modify: `packages/server/__tests__/pipeline-helpers/recording.ts`
- Modify: `packages/server/__tests__/pipeline-helpers/types.ts`
- Test: `packages/server/src/routes/pipeline/attempt-metadata.test.ts`
- Test: `packages/server/src/routes/pipeline/raw-fallback.test.ts`
- Test: `packages/server/src/routes/pipeline/model-stream.lifecycle.test.ts`

**Interfaces:**
- Consumes: `createAttemptResponseObservation`, `withAttemptResponseObservation`, and the semantic callbacks from Tasks 1-2.
- Produces: `RawTransportOptions = { readonly upstreamStream: boolean }`, an `observation` on every `CandidateSlot`, and an `AttemptEmitter.endAttempt()` path that writes aggregate attributes before all span terminals.

- [ ] **Step 1: Write failing pipeline tests for stream hints and attempt isolation**

Add a raw transport test that captures the third argument for both request modes:

```ts
test.each([
  { requested: true, expected: true },
  { requested: false, expected: false },
])('passes parsed upstream stream state $expected to raw transport', async ({ requested, expected }) => {
  let upstreamStream: boolean | undefined;
  const provider = rawProvider({
    id: 'raw',
    invoke: async (_request, _context, options) => {
      upstreamStream = options?.upstreamStream;
      return Response.json({ ok: true });
    },
  });
  const harness = pipeline([provider]);
  await (await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: requested }))).text();
  expect(upstreamStream).toBe(expected);
});
```

Extend recorded attempts with the seven new attributes. Add a fallback test proving two fake self-managed raw transports each end with their own `transportObservation: 'unavailable'`, and add a model test proving multiple text/reasoning deltas persist `contentGapP95Ms` on a buffered as well as SSE egress attempt.

- [ ] **Step 2: Run focused pipeline tests and confirm red**

```bash
rtk bun test packages/server/src/routes/pipeline/attempt-metadata.test.ts packages/server/src/routes/pipeline/raw-fallback.test.ts packages/server/src/routes/pipeline/model-stream.lifecycle.test.ts
```

Expected: FAIL because raw invoke has no third option and attempt spans do not contain aggregate fields.

- [ ] **Step 3: Add the backward-compatible raw transport option**

Use the same shape in plugin-sdk and server runtime:

```ts
export type RawTransportOptions = { readonly upstreamStream: boolean };

export type RawTransport = {
  readonly invoke: (
    request: Request,
    context?: LogicalRequestContext,
    options?: RawTransportOptions,
  ) => Promise<Response>;
};
```

Update the fake provider wrapper to forward argument three. In `attemptRawCandidate()`, use the already computed fact:

```ts
observation.markTransportUnavailable();
const response = await inAttempt(() =>
  raw.invoke(upstream, logicalRequest, { upstreamStream: ctx.streamRequested }),
);
```

Do not call `adapter.wantsStream()` again and do not inspect the raw body.

- [ ] **Step 4: Create and scope one collector per candidate**

Create `startedAt` once, create the collector from that same value, and nest it around the existing attempt log scope:

```ts
const startedAt = performance.now();
const observation = createAttemptResponseObservation({ startedAt });
const slot: CandidateSlot = {
  // existing fields
  startedAt,
  observation,
  inAttempt: <T>(operation: () => T): T =>
    withAttemptResponseObservation(observation, () =>
      withAttemptLogContext({ attemptIndex: index, providerId: provider.id, modelId: candidate.modelId }, operation),
    ),
};
```

Pass `observation` into raw/model usage capture. Mark transport unavailable immediately before raw/model provider execution; an injected fetch in Task 4 will replace it with pending/observed state. Pass `startedAt` for every model `streamText` capture because its upstream is streamed even when the client response is buffered; raw still gets `startedAt` only for an SSE request.

- [ ] **Step 5: Centralize attempt termination and write attributes**

Add these attribute names to `semantic.ts`:

```ts
transportObservation: 'aio_proxy.response.transport_observation',
upstreamHeadersMs: 'aio_proxy.response.upstream_headers_ms',
firstUpstreamByteMs: 'aio_proxy.response.first_upstream_byte_ms',
firstSseEventMs: 'aio_proxy.response.first_sse_event_ms',
contentGapP95Ms: 'aio_proxy.response.content_gap_p95_ms',
maxSseFramesPerRead: 'aio_proxy.response.max_sse_frames_per_read',
contentEncoding: 'aio_proxy.response.content_encoding',
```

`ALLOWED_ATTRIBUTES` already derives from `attributeName`; do not modify DB projection/schema. Add `AttemptEmitter.endAttempt(span, observation, terminal)`, have it set only snapshot properties that exist, then call `span.end(terminal)`. Route `emitAttempt`, raw non-2xx, mapped/unmapped exceptions, rejections, cancellation, and `settleSuccess` through this helper. Preserve `UsageCompletion.ttftMs` as the source of the existing TTFT attribute and root summary.

- [ ] **Step 6: Run pipeline lifecycle tests and type tests**

```bash
rtk bun test packages/server/src/routes/pipeline packages/server/src/request-tracing packages/server/__tests__/pipeline-helpers
rtk bun run --filter @aio-proxy/plugin-sdk test:types
```

Expected: PASS; fallbacks have isolated observations, cancellation snapshots occurred values, and existing root TTFT/usage remain intact.

- [ ] **Step 7: Commit attempt ownership and span emission**

```bash
rtk git add packages/plugin-sdk/src/runtime.ts packages/server/src/runtime.ts packages/server/src/routes/pipeline packages/server/src/request-tracing packages/server/__tests__/pipeline-helpers
rtk git commit -m "feat(server): persist per-attempt response observations" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Injected fetch transport observer

**Files:**
- Modify: `packages/server/src/request-logging/body-tap/body-tap.ts`
- Test: `packages/server/src/request-logging/body-tap/body-tap.test.ts`
- Modify: `packages/server/src/request-logging/wire/wire.ts`
- Test: `packages/server/src/request-logging/wire/wire.test.ts`
- Test: `packages/server/src/request-logging/wire/wire-response.test.ts`
- Test: `packages/server/src/provider-runtime/observed-fetch.test.ts`

**Interfaces:**
- Consumes: `currentAttemptResponseObservation()` from Task 1 and Bun's existing `decompress?: boolean` fetch option.
- Produces: a single pull-through observed response that records fetch headers, pre-decode first non-empty byte, identity SSE event/read batching, cancellation, and ambiguity without requiring debug logging.

- [ ] **Step 1: Write failing transport observation tests**

Add a non-debug attempt scope around `createObservedFetch()` and control the collector clock:

```ts
test('observes controlled identity SSE without enabling debug body logs', async () => {
  const times = [10, 20, 25];
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => times.shift() ?? 25 });
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: one\n\ndata: two\n\n'));
      controller.close();
    },
  });
  const fetcher = createObservedFetch(async () =>
    new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
  );
  const response = await withAttemptResponseObservation(observation, () =>
    fetcher('https://upstream.test', { decompress: false } as RequestInit & { decompress: false }),
  );
  await response.text();
  expect(observation.snapshot()).toEqual(expect.objectContaining({
    transportObservation: 'sse',
    upstreamHeadersMs: 10,
    firstUpstreamByteMs: 20,
    firstSseEventMs: 25,
    maxSseFramesPerRead: 2,
    contentEncoding: 'identity',
  }));
});
```

Add tests for: non-stream `decompress` absent records `body`/headers but omits byte/encoding; two resolved fetch responses become `ambiguous`; a split event is counted on the read that completes it; comment/keep-alive blocks do not count as dispatched SSE events; empty chunks do not set first byte; source cancellation is invoked once; no consumer means no body read.

- [ ] **Step 2: Run wire/body-tap tests and confirm red**

```bash
rtk bun test packages/server/src/request-logging/body-tap packages/server/src/request-logging/wire packages/server/src/provider-runtime/observed-fetch.test.ts
```

Expected: FAIL because non-debug fetches bypass observation and body taps do not expose source-read frame counts.

- [ ] **Step 3: Extend the existing single-reader body tap**

Keep existing debug callbacks and add optional best-effort callbacks rather than creating a second reader:

```ts
export type BodyTapObserver = {
  readonly chunk: (text: string) => void;
  readonly terminal: (terminal: BodyTapTerminal) => void;
  readonly sourceRead?: (byteLength: number) => void;
  readonly sseFrames?: (count: number) => void;
};
```

Call `sourceRead` only for a completed non-empty `reader.read()`. Make the existing `emit()` return the number of complete blank-line-delimited SSE blocks found in that specific source read, including a block whose carry began in an earlier read, then call `sseFrames(count)` as the per-read flush signal. The wire metric must use parser-dispatched event count rather than this raw block count. Do not count an unterminated EOF fragment as a block and keep `{ highWaterMark: 0 }` plus one cancellation path.

- [ ] **Step 4: Make `createObservedFetch` active for metrics independently of debug**

At invocation:

```ts
const debugScope = currentDebugRequestLogScope();
const observation = currentAttemptResponseObservation();
if (debugScope === undefined && observation === undefined) return fetcher(input, init);
observation?.observeFetchStart();
```

Only construct/log an observed request when the debug scope is complete. Always preserve the original input/init in a metrics-only request. After `fetcher` resolves, call:

```ts
const controlledStream = (init as BunFetchInit | undefined)?.decompress === false;
const bodyObservation = observation?.observeResponse(response, { controlledStream });
```

Wrap the response body once when debug logging or `bodyObservation` needs it. For controlled identity SSE, feed each complete block from the existing body tap into one `eventsource-parser` instance: `onEvent` calls `observation.observeSseEvent()` and increments the current read's dispatched-event count, while the body tap's per-read callback flushes that count through `bodyObservation.observeRead(byteLength, events)`. Comment/keep-alive and field-only blocks therefore do not count. Recoverable parser diagnostics must not stop later event counting; disable the parser dimension only when `feed()` actually throws. For compressed controlled streams, record non-empty encoded source bytes and encoding; raw passthrough may add the first decoded SSE event later, while `max_sse_frames_per_read` remains absent because encoded read boundaries cannot be mapped to decoded frames. Catch metrics parsing/statistics errors and disable only that dimension.

- [ ] **Step 5: Run transport observer and provider materialization tests**

```bash
rtk bun test packages/server/src/request-logging packages/server/src/provider-runtime/observed-fetch.test.ts packages/server/src/provider-runtime/proxy.test.ts
```

Expected: PASS; existing debug snapshots are byte-for-byte reconstructable, metrics work with debug false, and cancellation/backpressure tests retain one source reader.

- [ ] **Step 6: Commit the injected fetch observer**

```bash
rtk git add packages/server/src/request-logging packages/server/src/provider-runtime/observed-fetch.test.ts
rtk git commit -m "feat(server): observe upstream fetch latency" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 5: OpenAI wrapper streaming compression policy

**Files:**
- Modify: `packages/plugin-sdk/src/openai-stream/openai-stream-fetch.ts`
- Modify: `packages/plugin-sdk/src/openai-stream/index.ts`
- Test: `packages/plugin-sdk/src/openai-stream/openai-stream-fetch.request.test.ts`
- Test: `packages/plugin-sdk/src/openai-stream/openai-stream-fetch.response.test.ts`
- Test: `packages/plugin-sdk/src/openai-stream/openai-stream-fetch.decoding.test.ts`
- Test: `packages/plugin-sdk/src/openai-stream/openai-stream-fetch.errors.test.ts`
- Test: `packages/plugin-sdk/src/openai-stream/openai-stream-fetch-same-batch.test.ts`
- Test: `packages/plugin-sdk/src/openai-stream/openai-stream-bun.test.ts`

**Interfaces:**
- Consumes: wrapper-level `OpenAIStreamFetchOptions.upstreamStream`, explicit request headers, and optional per-call `OpenAIStreamFetchCallOptions.upstreamStream`.
- Produces: exported `OpenAIStreamFetch`, `OpenAIStreamFetchOptions`, and `OpenAIStreamFetchCallOptions`; the returned function remains assignable to `typeof globalThis.fetch` and preserves `preconnect`.

- [ ] **Step 1: Replace old unconditional-compression expectations with failing policy tests**

```ts
test('defaults managed upstream streams to identity and controlled decoding', async () => {
  const seen: { encoding?: string | null; decompress?: boolean } = {};
  const fetch = createOpenAIStreamFetch('openai-response', async (input, init) => {
    seen.encoding = new Request(input, init).headers.get('accept-encoding');
    seen.decompress = (init as { decompress?: boolean } | undefined)?.decompress;
    return Response.json({ ok: true });
  });
  await fetch('https://example.test');
  expect(seen).toEqual({ encoding: 'identity', decompress: false });
});

test('true non-stream calls leave encoding and decompression to Bun', async () => {
  let initSeen: (RequestInit & { decompress?: boolean }) | undefined;
  const fetch = createOpenAIStreamFetch('openai-response', async (_input, init) => {
    initSeen = init;
    return Response.json({ ok: true });
  });
  await fetch('https://example.test', undefined, { upstreamStream: false });
  expect(new Headers(initSeen?.headers).has('accept-encoding')).toBe(false);
  expect(Object.hasOwn(initSeen ?? {}, 'decompress')).toBe(false);
});

test('request header beats plugin fallback and per-call stream default', async () => {
  let encoding: string | null = null;
  const fetch = createOpenAIStreamFetch('openai-response', async (input, init, ...rest: unknown[]) => {
    encoding = new Request(input, init).headers.get('accept-encoding');
    expect(rest).toEqual([]);
    return Response.json({ ok: true });
  }, { acceptEncoding: 'identity', upstreamStream: true });
  await fetch('https://example.test', { headers: { 'ACCEPT-ENCODING': 'gzip' } }, { upstreamStream: false });
  expect(encoding).toBe('gzip');
});
```

Add a response test where a call declared non-stream receives an already platform-decoded SSE body while `Content-Encoding: gzip` remains. Assert terminal protection works and no second decompression occurs. Keep existing compressed-stream split-frame, same-batch, late-error, and cancellation tests.

- [ ] **Step 2: Run the OpenAI wrapper tests and confirm red**

```bash
rtk bun test packages/plugin-sdk/src/openai-stream/openai-stream-fetch.request.test.ts packages/plugin-sdk/src/openai-stream/openai-stream-fetch.response.test.ts
```

Expected: FAIL on the old gzip-list default, overridden explicit header, and missing third-call option.

- [ ] **Step 3: Add the stream-aware fetch type and policy**

```ts
export type OpenAIStreamFetchCallOptions = { readonly upstreamStream?: boolean };

export type OpenAIStreamFetch = typeof globalThis.fetch & {
  (
    input: RequestInfo | URL,
    init?: RequestInit,
    options?: OpenAIStreamFetchCallOptions,
  ): Promise<Response>;
};

export type OpenAIStreamFetchOptions = {
  readonly acceptEncoding?: string;
  readonly rewriteToolImages?: boolean;
  readonly upstreamStream?: boolean;
};
```

Resolve `options?.upstreamStream ?? wrapperOptions.upstreamStream ?? true`. After optional tool-image rewriting, preserve an explicit case-insensitive request header. Otherwise apply `acceptEncoding`, else `identity` only for a stream. A stream calls the underlying fetch with `{ headers, decompress: false }`; a non-stream call passes headers without any `decompress` property. Consume the third option in this wrapper and never forward it to the underlying fetch.

Split response normalization by the resolved stream fact:

```ts
if (upstreamStream) return normalizeControlledResponse(response, protocol);
if (!isEventStream(response.headers.get('content-type'))) return response;
return normalizeUnexpectedSse(response, protocol); // identity reader only; no Content-Encoding decode
```

`normalizeControlledResponse` retains the current decoder and terminal code. `normalizeUnexpectedSse` wraps Bun's exposed body in `createContentDecodedReader(source, null)` only to reuse terminal demand/cancellation; it removes stale representation headers but never interprets `response.headers.get('content-encoding')`.

- [ ] **Step 4: Run all plugin-sdk OpenAI-stream regression tests and artifact/type tests**

```bash
rtk bun test packages/plugin-sdk/src/openai-stream
rtk bun run --filter @aio-proxy/plugin-sdk test:types
rtk bun run --filter @aio-proxy/plugin-sdk build
rtk bun run --filter @aio-proxy/plugin-sdk test:artifact
```

Expected: PASS; generated declarations expose the intentional overload, and compressed terminal/cancel behavior is unchanged.

- [ ] **Step 5: Commit the wrapper policy**

```bash
rtk git add packages/plugin-sdk/src/openai-stream
rtk git commit -m "fix(plugin-sdk): default OpenAI streams to identity" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 6: Managed provider propagation and integration verification

**Files:**
- Modify: `packages/core/src/provider/openai-stream-fetch.ts`
- Modify: `packages/core/src/provider/api/api.ts`
- Modify: `packages/server/src/provider-runtime/materialize.ts`
- Modify: `packages/plugins/openai-chatgpt/src/runtime/runtime.ts`
- Test: `packages/core/src/provider/api/api-fetch.test.ts`
- Test: `packages/core/src/provider/api/api-stream.test.ts`
- Test: `packages/core/src/provider/api/api-passthrough.test.ts`
- Test: `packages/core/src/provider/api/api-openai-stream.test.ts`
- Test: `packages/core/src/provider/ai-sdk/ai-sdk.test.ts`
- Test: `packages/core/src/provider/ai-sdk/ai-sdk-openai-stream.test.ts`
- Test: `packages/core/src/provider/api-bridge/api-bridge-openai-stream.test.ts`
- Test: `packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts`
- Test: `packages/plugins/openai-chatgpt/src/runtime/runtime-stream.test.ts`
- Test: `packages/server/src/provider-runtime/observed-fetch.test.ts`
- Test: `packages/server/src/routes/pipeline/attempt-metadata.test.ts`

**Interfaces:**
- Consumes: `OpenAIStreamFetch` from Task 5 and `RawTransportOptions` from Task 3.
- Produces: generic API `passthrough(request, options?)`, raw materialization that forwards argument three, AI SDK wrapper default `upstreamStream: true`, and openai-chatgpt shared dynamic fetch with model default plus raw per-call override.

- [ ] **Step 1: Write failing generic API and AI SDK policy tests**

Update old assertions to the approved policy:

```ts
const clientRequest = new Request('https://proxy.test/v1/responses', {
  headers: { 'accept-encoding': 'gzip' },
});
await provider.passthrough(clientRequest.clone(), { upstreamStream: true });
expect(seenHeaders.get('accept-encoding')).toBe('identity');
expect(seenDecompress).toBe(false);

await provider.passthrough(clientRequest, { upstreamStream: false });
expect(seenHeaders.has('accept-encoding')).toBe(false);
expect(seenInitHasDecompress).toBe(false);
```

Add a provider with `headers: { 'Accept-Encoding': 'zstd' }` and assert both stream and non-stream calls preserve `zstd`, proving config is applied after client header removal. In the AI SDK loader test, call the captured provider fetch and assert the wrapper-level model default sends `identity` with `decompress: false`, independent of whether client egress is buffered.

- [ ] **Step 2: Write failing openai-chatgpt shared-fetch tests**

Extend `runtime-stream.test.ts`:

```ts
const raw = runtime.raw?.({ protocol: 'openai-response', modelId: 'gpt-5.5' });
await raw!.invoke(
  new Request('https://api.openai.com/v1/responses', { headers: { 'accept-encoding': 'br' } }),
  undefined,
  { upstreamStream: false },
);
expect(upstreamAcceptEncoding).toBe('identity'); // plugin fallback, not client br
expect(upstreamInitHasDecompress).toBe(false);
```

Keep the model test asserting `identity` plus controlled decoding, and add an unexpected-SSE raw non-stream terminal test to prove it is wrapped without double decoding.

- [ ] **Step 3: Run the focused core/plugin tests and confirm red**

```bash
rtk bun test packages/core/src/provider/api packages/core/src/provider/ai-sdk packages/core/src/provider/api-bridge packages/plugins/openai-chatgpt/src/runtime
```

Expected: FAIL because generic API does not strip client encoding/forward the hint and ChatGPT raw does not accept argument three.

- [ ] **Step 4: Forward the stream policy through managed providers**

In core wrapper construction, declare model requests as upstream streams:

```ts
return createOpenAIStreamFetch(protocol, fetcher, { upstreamStream: true });
```

For `@ai-sdk/openai-compatible`, combine this with `rewriteToolImages: true`. Extend `ApiProviderInstance.passthrough` with optional `{ upstreamStream: boolean }`; in `upstreamHeaders()` delete inbound `accept-encoding` before applying `config.headers`, then call the stream-aware wrapper with the per-call value. Do not put `upstreamStream` in `RequestInit`.

In `materializeRuntimeProvider()` adapt the legacy API capability explicitly:

```ts
raw: {
  resolve: ({ protocol }) =>
    protocol === provider.protocol
      ? { invoke: (request, _context, options) => provider.passthrough(request, options) }
      : undefined,
},
```

This preserves direct two-argument plugins and lets generic API consume the third hint.

- [ ] **Step 5: Keep openai-chatgpt model/raw on one fetch**

Create its shared OpenAI wrapper with `{ acceptEncoding: 'identity', upstreamStream: true }`. Give the dynamic fetch the same optional third call option as `OpenAIStreamFetch`. Before calling the shared wrapper, delete `accept-encoding` together with inbound authorization/host; raw forwards its third option, while the AI SDK model call supplies none and therefore uses wrapper default `true`.

- [ ] **Step 6: Run affected package suites and integration assertions**

```bash
rtk bun test packages/plugin-sdk/src/openai-stream packages/core/src/provider packages/plugins/openai-chatgpt/src/runtime packages/server/src/request-logging packages/server/src/routes/pipeline packages/server/src/provider-runtime
rtk bun run --filter @aio-proxy/plugin-sdk build
rtk bun run --filter @aio-proxy/core build
rtk bun run --filter @aio-proxy/plugin-openai-chatgpt build
```

Expected: PASS. Confirm the attempt test detail contains aggregate attributes, raw/provider response bytes are unchanged, explicit compression still decodes/cancels correctly, and fake opaque providers report `unavailable` rather than zeroes.

- [ ] **Step 7: Run formatting/lint checks on the changed scope and the full relative-baseline verification**

```bash
rtk bunx oxfmt --check packages/plugin-sdk/src/openai-stream packages/core/src/provider packages/plugins/openai-chatgpt/src/runtime packages/server/src/response-observation packages/server/src/request-logging packages/server/src/usage-capture packages/server/src/passthrough-usage packages/server/src/routes/pipeline packages/server/src/request-tracing
rtk bun run lint:types
rtk bun run preflight
rtk git status --short
```

Expected: changed-scope format and type-aware lint PASS. `preflight` may report only the two approved baseline failures (`CHANGELOG.md` formatting and xai-grok artifact version); any new failure blocks completion. Git status contains only intentional source/test/plan changes.

- [ ] **Step 8: Commit managed integration**

```bash
rtk git add packages/core/src/provider packages/plugins/openai-chatgpt/src/runtime packages/server/src/provider-runtime packages/server/src/routes/pipeline/attempt-metadata.test.ts
rtk git commit -m "feat: apply stream policy to managed OpenAI providers" -m "Co-authored-by: Codex <noreply@openai.com>"
```
