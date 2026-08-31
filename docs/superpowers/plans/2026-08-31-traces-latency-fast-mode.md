# Traces Latency Grades and Fast-Mode Marker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/dashboard/traces` latency dots follow new-api's first-token / duration / throughput grades, and show the lightning icon only when the inbound request asked for fast/priority.

**Architecture:** Port new-api's three absolute thresholds into a dashboard-only grade helper and keep using the existing three dot tokens (`bg-primary` / `bg-muted-foreground` / `bg-destructive`). Persist inbound fast-mode as a root-span boolean (`aio_proxy.request.fast`) the same way stream intent is already persisted, then let `TraceLatencyCell` read `fast` instead of `durationMs < 1000`.

**Tech Stack:** TypeScript, Bun tests (`packages/server`, `packages/core`), rstest (`packages/dashboard`), existing dashboard i18n / Changesets.

**Spec:** [docs/superpowers/specs/2026-08-31-traces-latency-fast-mode-design.md](../specs/2026-08-31-traces-latency-fast-mode-design.md)

## Global Constraints

- Color tokens stay `bg-primary` (success), `bg-muted-foreground` (warning), `bg-destructive` (danger). Do not add `--success` / `--warning` CSS or color the numeric labels.
- Do not add a TPS column, timing bar, or new-api's colored text.
- Fast-mode is an inbound request signal, not routing `AliasDimensions.speed`. `service_tier: "fast"` must not light the icon.
- Persist `aio_proxy.request.fast = true` only on match; omit the attribute otherwise. Do not store raw `service_tier` / `speed` / beta header strings.
- `ALLOWED_ATTRIBUTES` is `Object.values(attributeName)`. Adding `attributeName.fast` is enough to persist the flag; do not edit `span-record.ts`.
- File-size limits: do not grow handwritten non-test files past 500 lines. `packages/server/src/routes/pipeline/index.ts` is ~320 lines; add only the identify spread. `packages/server/src/request-tracing/semantic.ts` is ~236 lines; add one attribute key.
- Dashboard module layout: helpers go in `packages/dashboard/src/modules/traces/lib/<name>/` with export-only `index.ts`. Components stay one React component per `.tsx` file.
- User-facing copy uses i18n. `TTFT` stays a literal. After editing `packages/i18n/messages/*.json`, run `bun run i18n:compile`.
- Changeset targets `aio-proxy` plus every edited workspace package, all `patch`. Do not run `changeset version` or `changeset publish`.
- Every commit message must end with `Co-authored-by: Codex <noreply@openai.com>`.
- This worktree may already contain a draft of the fast-mode detector, trace attribute, lightning prop, and `.changeset/traces-fast-mode-marker.md`. Reconcile that draft to the code blocks below. Do not add a second detector, a second `fast` attribute, or a second changeset.

## File map

- `docs/superpowers/specs/2026-08-31-traces-latency-fast-mode-design.md` — already written. Do not rewrite unless a task finds a contradiction.
- `packages/server/src/request-tracing/fast-mode/` — inbound fast-mode detector (`requestAsksFastMode`).
- `packages/server/src/request-tracing/semantic.ts` — `attributeName.fast = 'aio_proxy.request.fast'`.
- `packages/server/src/request-tracing/request-trace-recorder/types.ts` — optional `fastRequested` on identify input.
- `packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.ts` — set the root attribute when `fastRequested === true`.
- `packages/types/src/trace.ts` — optional `fast` on `DashboardTraceSummarySchema`.
- `packages/core/src/db/trace-store/trace-queries.ts` — project the attribute onto summaries.
- `packages/server/src/routes/pipeline/index.ts` — pass the detector result into `session.identify`.
- `packages/server/src/routes/token-count/token-count.ts` — same identify spread.
- `packages/dashboard/src/modules/traces/lib/trace-latency-grade/` — new-api grade functions and dot class names.
- `packages/dashboard/src/modules/traces/components/trace-latency-cell/` — consume grades + `fast`.
- `packages/dashboard/src/modules/traces/components/traces-table/traces-table.tsx` — pass `fast` and `outputTokens`.
- `packages/i18n/messages/*.json` — lightning aria-label copy.
- `.changeset/traces-fast-mode-marker.md` — one patch note for both behaviors.

---

### Task 1: Detect inbound fast-mode

**Files:**
- Create: `packages/server/src/request-tracing/fast-mode/fast-mode.ts`
- Create: `packages/server/src/request-tracing/fast-mode/index.ts`
- Create: `packages/server/src/request-tracing/fast-mode/fast-mode.test.ts`
- Modify: `packages/server/src/request-tracing/index.ts`

**Interfaces:**
- Consumes: parsed request body (`unknown`) and inbound `Headers`.
- Produces: `requestAsksFastMode(body: unknown, headers: Headers): boolean`.
- Produces: true when any of:
  - `headers.get('anthropic-beta')` includes `'fast-mode-2026-02-01'`
  - body `service_tier` string, trimmed and lowercased, equals `'priority'`
  - body `speed` string, trimmed and lowercased, equals `'fast'`
- Produces: false for `service_tier: 'fast' | 'flex' | 'standard'`, `speed: 'standard' | 'flex'`, unrelated betas, non-objects, and missing fields.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/request-tracing/fast-mode/fast-mode.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { requestAsksFastMode } from './fast-mode';

describe('requestAsksFastMode', () => {
  test('matches priority service_tier, fast speed, and the Anthropic fast-mode beta', () => {
    expect(requestAsksFastMode({ service_tier: 'priority' }, new Headers())).toBe(true);
    expect(requestAsksFastMode({ speed: 'fast' }, new Headers())).toBe(true);
    expect(
      requestAsksFastMode(
        {},
        new Headers({ 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14, fast-mode-2026-02-01' }),
      ),
    ).toBe(true);
  });

  test('ignores neighboring tiers, speeds, and unrelated beta tokens', () => {
    expect(requestAsksFastMode({ service_tier: 'flex' }, new Headers())).toBe(false);
    expect(requestAsksFastMode({ service_tier: 'fast' }, new Headers())).toBe(false);
    expect(requestAsksFastMode({ speed: 'standard' }, new Headers())).toBe(false);
    expect(requestAsksFastMode({}, new Headers({ 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14' }))).toBe(
      false,
    );
    expect(requestAsksFastMode(null, new Headers())).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun run --filter @aio-proxy/server test:unit -- src/request-tracing/fast-mode/fast-mode.test.ts
```

Expected: FAIL with `Cannot find module './fast-mode'` (or `requestAsksFastMode` is not exported).

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/request-tracing/fast-mode/fast-mode.ts`:

```ts
import { isPlainObject } from 'es-toolkit/predicate';

const ANTHROPIC_FAST_MODE_BETA = 'fast-mode-2026-02-01';

export function requestAsksFastMode(body: unknown, headers: Headers): boolean {
  if (headers.get('anthropic-beta')?.includes(ANTHROPIC_FAST_MODE_BETA) === true) return true;
  if (!isPlainObject(body)) return false;
  return field(body.service_tier) === 'priority' || field(body.speed) === 'fast';
}

function field(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
}
```

Create `packages/server/src/request-tracing/fast-mode/index.ts`:

```ts
export { requestAsksFastMode } from './fast-mode';
```

Add this export to `packages/server/src/request-tracing/index.ts` next to the existing `semantic` re-export:

```ts
export { requestAsksFastMode } from './fast-mode';
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
bun run --filter @aio-proxy/server test:unit -- src/request-tracing/fast-mode/fast-mode.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/request-tracing/fast-mode packages/server/src/request-tracing/index.ts
git commit -m "$(cat <<'EOF'
server: detect inbound fast-mode from body and Anthropic beta

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 2: Persist fast-mode on the trace summary

**Files:**
- Modify: `packages/server/src/request-tracing/semantic.ts`
- Modify: `packages/server/src/request-tracing/request-trace-recorder/types.ts`
- Modify: `packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.ts`
- Modify: `packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.test.ts`
- Modify: `packages/types/src/trace.ts`
- Modify: `packages/core/src/db/trace-store/trace-queries.ts`
- Modify: `packages/core/src/db/trace-store/trace-store.test.ts`

**Interfaces:**
- Consumes: `requestAsksFastMode` is not called here. This task only stores a boolean already decided by the caller.
- Consumes: `RequestTraceIdentityInput.streamRequested?: boolean` as the pattern to copy.
- Produces: `attributeName.fast = 'aio_proxy.request.fast'`.
- Produces: `RequestTraceIdentityInput.fastRequested?: boolean`.
- Produces: `identify({ fastRequested: true })` sets root attribute `aio_proxy.request.fast = true`.
- Produces: `DashboardTraceSummary.fast?: boolean`, present only when the stored attribute is `true`.

- [ ] **Step 1: Write the failing tests**

Append this test to `packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.test.ts` inside the existing `createRequestTraceRecorder` describe, after `projects stream intent and final TTFT onto the root span`:

```ts
  test('projects fast-mode intent onto the root span', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

    session.identify({ ...identityInput, fastRequested: true });
    session.finish({ outcome: 'success' });

    const root = completions[0]?.spans.find((span) => span.spanId === session.rootSpanId);
    expect(root?.attributes).toMatchObject({ [attributeName.fast]: true });
  });
```

Append this test to `packages/core/src/db/trace-store/trace-store.test.ts` after `projects root stream intent and TTFT into trace summaries`:

```ts
  test('projects root fast-mode intent into trace summaries', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot(rootStart());
      store.complete(
        completion({
          spans: [
            rootSpan({
              attributes: {
                'aio_proxy.request.id': 'request-a',
                'aio_proxy.protocol.inbound': 'openai-compatible',
                'aio_proxy.request.fast': true,
              },
            }),
          ],
        }),
      );

      expect(store.find(TRACE_ID)?.trace).toMatchObject({ fast: true });
    } finally {
      handle.close();
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun run --filter @aio-proxy/server test:unit -- src/request-tracing/request-trace-recorder/request-trace-recorder.test.ts
bun run --filter @aio-proxy/core test:unit -- src/db/trace-store/trace-store.test.ts
```

Expected:
- recorder test FAIL: `fastRequested` does not exist, or `attributeName.fast` is undefined.
- store test FAIL: summary does not contain `{ fast: true }`.

- [ ] **Step 3: Write minimal implementation**

In `packages/server/src/request-tracing/semantic.ts`, add `fast` next to `stream`:

```ts
  stream: 'aio_proxy.request.stream',
  fast: 'aio_proxy.request.fast',
```

In `packages/server/src/request-tracing/request-trace-recorder/types.ts`:

```ts
export type RequestTraceIdentityInput = {
  readonly requestedModelId: string;
  readonly resolution: LogicalSessionResolution;
  readonly mutateSessionState: boolean;
  readonly streamRequested?: boolean;
  readonly fastRequested?: boolean;
};
```

In `packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.ts`, inside `identify`, immediately after the stream attribute line:

```ts
if (input.streamRequested !== undefined) root.setAttribute(attributeName.stream, input.streamRequested);
if (input.fastRequested === true) root.setAttribute(attributeName.fast, true);
```

In `packages/types/src/trace.ts`, add `fast` next to `stream` on `DashboardTraceSummarySchema`:

```ts
  stream: z.boolean().optional(),
  fast: z.boolean().optional(),
  ttftMs: z.number().min(0).optional(),
```

In `packages/core/src/db/trace-store/trace-queries.ts` `rowToSummary`:

```ts
  const stream = row.attributes['aio_proxy.request.stream'];
  const fast = row.attributes['aio_proxy.request.fast'];
  const ttftMs = row.attributes['aio_proxy.response.ttft_ms'];
```

and in the returned object, next to `stream`:

```ts
    ...(typeof stream === 'boolean' ? { stream } : {}),
    ...(fast === true ? { fast: true } : {}),
    ...(typeof ttftMs === 'number' && Number.isFinite(ttftMs) && ttftMs >= 0 ? { ttftMs } : {}),
```

Do not project `fast: false`. Missing attribute means unmarked.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
bun run --filter @aio-proxy/server test:unit -- src/request-tracing/request-trace-recorder/request-trace-recorder.test.ts
bun run --filter @aio-proxy/core test:unit -- src/db/trace-store/trace-store.test.ts
```

Expected: PASS, including the two new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/request-tracing/semantic.ts packages/server/src/request-tracing/request-trace-recorder packages/types/src/trace.ts packages/core/src/db/trace-store/trace-queries.ts packages/core/src/db/trace-store/trace-store.test.ts
git commit -m "$(cat <<'EOF'
core: persist inbound fast-mode on dashboard traces

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 3: Record fast-mode from live inbound requests

**Files:**
- Modify: `packages/server/src/routes/pipeline/index.ts`
- Modify: `packages/server/src/routes/token-count/token-count.ts`
- Create: `packages/server/src/routes/pipeline/fast-mode.test.ts`
- Modify: `packages/server/__tests__/pipeline-helpers/types.ts`
- Modify: `packages/server/__tests__/pipeline-helpers/adapter.ts`

**Interfaces:**
- Consumes: `requestAsksFastMode(body: unknown, headers: Headers): boolean` from Task 1.
- Consumes: `RequestTraceIdentityInput.fastRequested?: boolean` from Task 2.
- Consumes: parsed protocol request object and `rawRequest.headers`.
- Produces: generation and token-count identify calls include `{ fastRequested: true }` only when the detector returns true.
- Produces: completed root span `aio_proxy.request` has `aio_proxy.request.fast = true` for matching inbound requests and omits it otherwise.

- [ ] **Step 1: Write the failing tests**

The pipeline test adapter currently drops unknown body fields. Extend `TestProtocolRequest` in `packages/server/__tests__/pipeline-helpers/types.ts`:

```ts
export type TestProtocolRequest = {
  readonly model: string;
  readonly prompt: string;
  readonly stream: boolean;
  readonly service_tier?: string;
  readonly speed?: string;
};
```

In `packages/server/__tests__/pipeline-helpers/adapter.ts` `parse`, keep returning those optional fields when they are strings:

```ts
      return {
        model: value.model,
        prompt: 'prompt' in value && typeof value.prompt === 'string' ? value.prompt : 'ping',
        stream: 'stream' in value && value.stream === true,
        ...('service_tier' in value && typeof value.service_tier === 'string'
          ? { service_tier: value.service_tier }
          : {}),
        ...('speed' in value && typeof value.speed === 'string' ? { speed: value.speed } : {}),
      };
```

Create `packages/server/src/routes/pipeline/fast-mode.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { jsonRequest, REQUESTED_MODEL, rawProvider } from '../../../__tests__/pipeline-helpers';
import { attributeName, spanName } from '../../request-tracing';
import { pipeline } from './test-support';

test('records inbound fast-mode from body service_tier', async () => {
  const harness = pipeline([rawProvider({ id: 'raw' })]);

  expect(
    (await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping', service_tier: 'priority' }))).status,
  ).toBe(200);
  expect(harness.recording.spans.find((span) => span.name === spanName.request)?.attributes[attributeName.fast]).toBe(
    true,
  );
});

test('records inbound fast-mode from body speed', async () => {
  const harness = pipeline([rawProvider({ id: 'raw' })]);

  expect((await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping', speed: 'fast' }))).status).toBe(200);
  expect(harness.recording.spans.find((span) => span.name === spanName.request)?.attributes[attributeName.fast]).toBe(
    true,
  );
});

test('records inbound fast-mode from the Anthropic beta header', async () => {
  const harness = pipeline([rawProvider({ id: 'raw' })]);
  const request = new Request('http://localhost/v1/test', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-beta': 'fast-mode-2026-02-01',
    },
    body: JSON.stringify({ model: REQUESTED_MODEL, prompt: 'ping' }),
  });

  expect((await harness.run(request)).status).toBe(200);
  expect(harness.recording.spans.find((span) => span.name === spanName.request)?.attributes[attributeName.fast]).toBe(
    true,
  );
});

test('does not mark ordinary requests as fast-mode', async () => {
  const harness = pipeline([rawProvider({ id: 'raw' })]);

  expect((await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' }))).status).toBe(200);
  expect(
    harness.recording.spans.find((span) => span.name === spanName.request)?.attributes[attributeName.fast],
  ).toBeUndefined();
});
```

Use `rawProvider`, not `modelProvider`. The test adapter's model path is not needed here and can 502 if catalog/materialization is cold.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun run --filter @aio-proxy/server test:unit -- src/routes/pipeline/fast-mode.test.ts
```

Expected: the three matching cases FAIL because the root span has no `aio_proxy.request.fast`. The ordinary-request case already passes.

- [ ] **Step 3: Write minimal implementation**

In `packages/server/src/routes/pipeline/index.ts`, change the request-tracing import to:

```ts
import { requestAsksFastMode, type RequestTraceSession } from '../../request-tracing';
```

and spread the flag onto the existing `session.identify` call:

```ts
    session.identify({
      requestedModelId: requestedModel,
      resolution,
      mutateSessionState: true,
      streamRequested,
      ...(requestAsksFastMode(request, rawRequest.headers) ? { fastRequested: true } : {}),
    });
```

In `packages/server/src/routes/token-count/token-count.ts`, change the request-tracing import to:

```ts
import { attributeName, requestAsksFastMode, type RequestTraceSession } from '../../request-tracing';
```

and replace the current `session.identify({ requestedModelId, resolution, mutateSessionState: false })` with:

```ts
    session.identify({
      requestedModelId: requestedModel,
      resolution,
      mutateSessionState: false,
      ...(requestAsksFastMode(request, rawRequest.headers) ? { fastRequested: true } : {}),
    });
```

Do not add a token-count HTTP test. Token-count uses the same detector and identify field; covering generation is enough.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
bun run --filter @aio-proxy/server test:unit -- src/routes/pipeline/fast-mode.test.ts src/request-tracing/fast-mode/fast-mode.test.ts
```

Expected: PASS (4 pipeline tests + 2 detector tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/pipeline/index.ts packages/server/src/routes/pipeline/fast-mode.test.ts packages/server/src/routes/token-count/token-count.ts packages/server/__tests__/pipeline-helpers/types.ts packages/server/__tests__/pipeline-helpers/adapter.ts
git commit -m "$(cat <<'EOF'
server: record inbound fast-mode on request traces

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 4: Show the lightning icon only for fast-mode

**Files:**
- Modify: `packages/dashboard/src/modules/traces/components/trace-latency-cell/trace-latency-cell.tsx`
- Modify: `packages/dashboard/src/modules/traces/components/trace-latency-cell/trace-latency-cell.test.tsx`
- Modify: `packages/dashboard/src/modules/traces/components/traces-table/traces-table.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Modify: `packages/i18n/messages/zh-Hant.json`
- Modify: `packages/i18n/messages/ja.json`
- Modify: `packages/i18n/messages/ko.json`

**Interfaces:**
- Consumes: `DashboardTraceSummary.fast?: boolean` from Task 2.
- Produces: `TraceLatencyCellProps.fast?: boolean`.
- Produces: Zap with `data-fast-marker` renders iff `fast === true`, including when `durationMs >= 1000`.
- Produces: a 125ms request without `fast` does not render the marker.
- Produces: aria-label `dashboard.traces.fast_latency` reads as fast mode, not "short latency".

- [ ] **Step 1: Write the failing tests**

Replace `packages/dashboard/src/modules/traces/components/trace-latency-cell/trace-latency-cell.test.tsx` with:

```tsx
import { expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { TraceLatencyCell } from './trace-latency-cell';

test('aligns duration and TTFT while marking only present values', () => {
  const view = render(<TraceLatencyCell durationMs={125} stream ttftMs={42} />);

  expect(screen.getByText(/125/u)).toBeTruthy();
  expect(screen.getByText(/TTFT.*42/u)).toBeTruthy();
  expect(view.container.querySelectorAll('[data-latency-dot]')).toHaveLength(2);
  expect(view.container.querySelector('[data-fast-marker]')).toBeNull();

  view.rerender(<TraceLatencyCell durationMs={250} stream />);
  expect(screen.getByText(/TTFT.*—/u)).toBeTruthy();
  expect(view.container.querySelectorAll('[data-latency-dot]')).toHaveLength(1);
});

test('marks fast-mode requests independently of duration', () => {
  const view = render(<TraceLatencyCell durationMs={5_000} fast />);

  expect(view.container.querySelector('[data-fast-marker]')).toBeTruthy();

  view.rerender(<TraceLatencyCell durationMs={125} />);
  expect(view.container.querySelector('[data-fast-marker]')).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun run --filter @aio-proxy/dashboard test:unit -- src/modules/traces/components/trace-latency-cell/trace-latency-cell.test.tsx
```

Expected:
- first test FAIL: 125ms still renders `[data-fast-marker]`.
- second test FAIL: `durationMs={5000} fast` does not render the marker.

- [ ] **Step 3: Write minimal implementation**

Update `packages/dashboard/src/modules/traces/components/trace-latency-cell/trace-latency-cell.tsx` props and Zap condition only. Leave `dotClassName` alone until Task 5.

```tsx
interface TraceLatencyCellProps {
  readonly durationMs: number;
  readonly stream?: boolean | undefined;
  readonly ttftMs?: number | undefined;
  readonly fast?: boolean | undefined;
}

export const TraceLatencyCell: React.FC<TraceLatencyCellProps> = ({
  durationMs,
  stream = false,
  ttftMs,
  fast = false,
}) => (
  <div className="grid min-w-32 grid-cols-[0.375rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
    <span aria-hidden="true" className={dotClassName(durationMs)} data-latency-dot />
    <span className="inline-flex items-center gap-1.5">
      {formatTraceDuration(durationMs)}
      {fast ? (
        <Zap aria-label={m['dashboard.traces.fast_latency']()} className="size-3 text-primary" data-fast-marker />
      ) : null}
    </span>
    {/* stream / TTFT block unchanged */}
  </div>
);
```

In `packages/dashboard/src/modules/traces/components/traces-table/traces-table.tsx` latency cell:

```tsx
      <TraceLatencyCell
        durationMs={row.original.durationMs}
        stream={row.original.stream}
        ttftMs={row.original.ttftMs}
        fast={row.original.fast}
      />
```

Update `dashboard.traces.fast_latency` in every locale:

- `packages/i18n/messages/en.json`: `"Fast"` → `"Fast mode"`
- `packages/i18n/messages/zh-Hans.json`: `"快速"` → `"快速模式"`
- `packages/i18n/messages/zh-Hant.json`: `"快速"` → `"快速模式"`
- `packages/i18n/messages/ja.json`: `"高速"` → `"高速モード"`
- `packages/i18n/messages/ko.json`: `"빠름"` → `"빠른 모드"`

Then compile:

```bash
bun run i18n:compile
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
bun run --filter @aio-proxy/dashboard test:unit -- src/modules/traces/components/trace-latency-cell/trace-latency-cell.test.tsx src/modules/traces/components/traces-table/traces-table.test.tsx src/modules/traces/templates/traces-page/traces-page.test.tsx
```

Expected: PASS. Existing traces table/page tests do not assert the lightning icon.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/modules/traces/components/trace-latency-cell packages/dashboard/src/modules/traces/components/traces-table/traces-table.tsx packages/i18n/messages
git commit -m "$(cat <<'EOF'
dashboard: show traces lightning icon for fast-mode requests

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

If `bun run i18n:compile` rewrote generated paraglide files, add those too. Do not commit unrelated i18n churn.

---

### Task 5: Port new-api latency color grades

**Files:**
- Create: `packages/dashboard/src/modules/traces/lib/trace-latency-grade/trace-latency-grade.ts`
- Create: `packages/dashboard/src/modules/traces/lib/trace-latency-grade/index.ts`
- Create: `packages/dashboard/src/modules/traces/lib/trace-latency-grade/trace-latency-grade.test.ts`
- Modify: `packages/dashboard/src/modules/traces/components/trace-latency-cell/trace-latency-cell.tsx`
- Modify: `packages/dashboard/src/modules/traces/components/trace-latency-cell/trace-latency-cell.test.tsx`
- Modify: `packages/dashboard/src/modules/traces/components/traces-table/traces-table.tsx`
- Create: `.changeset/traces-fast-mode-marker.md`

**Interfaces:**
- Consumes: new-api thresholds from `.reference/new-api/web/src/features/usage-logs/lib/format.ts`:
  - TTFT seconds: `< 5` success, `< 10` warning, else danger
  - duration seconds when `outputTokens < 100` or `seconds <= 0`: `< 10` success, `< 30` warning, else danger
  - otherwise throughput `outputTokens / seconds`: `>= 30` success, `>= 15` warning, else danger
- Consumes: `DashboardTraceSummary.usage?.outputTokens`.
- Produces:
  - `export type LatencyGrade = 'success' | 'warning' | 'danger'`
  - `firstResponseTimeGrade(milliseconds: number): LatencyGrade`
  - `responseTimeGrade(milliseconds: number, outputTokens?: number): LatencyGrade`
  - `latencyDotClassName(grade: LatencyGrade): string` → `bg-primary` / `bg-muted-foreground` / `bg-destructive`
- Produces: duration dot uses `responseTimeGrade(durationMs, outputTokens ?? 0)`.
- Produces: TTFT dot uses `firstResponseTimeGrade(ttftMs)` when `ttftMs` is present.
- Missing `outputTokens` is `0`, so duration stays on the wall-clock scale.

- [ ] **Step 1: Write the failing tests**

Create `packages/dashboard/src/modules/traces/lib/trace-latency-grade/trace-latency-grade.test.ts`:

```ts
import { expect, test } from '@rstest/core';

import { firstResponseTimeGrade, latencyDotClassName, responseTimeGrade } from './trace-latency-grade';

test('grades TTFT on first-token wall-clock thresholds', () => {
  expect(firstResponseTimeGrade(4_999)).toBe('success');
  expect(firstResponseTimeGrade(5_000)).toBe('warning');
  expect(firstResponseTimeGrade(9_999)).toBe('warning');
  expect(firstResponseTimeGrade(10_000)).toBe('danger');
});

test('grades short-output duration on wall-clock', () => {
  expect(responseTimeGrade(9_999, 99)).toBe('success');
  expect(responseTimeGrade(10_000, 99)).toBe('warning');
  expect(responseTimeGrade(29_999, 0)).toBe('warning');
  expect(responseTimeGrade(30_000)).toBe('danger');
});

test('grades long-output duration on generated tokens per second', () => {
  expect(responseTimeGrade(8_000, 240)).toBe('success');
  expect(responseTimeGrade(8_000, 120)).toBe('warning');
  expect(responseTimeGrade(8_000, 100)).toBe('danger');
});

test('maps grades onto the existing latency-dot tokens', () => {
  expect(latencyDotClassName('success')).toContain('bg-primary');
  expect(latencyDotClassName('warning')).toContain('bg-muted-foreground');
  expect(latencyDotClassName('danger')).toContain('bg-destructive');
});
```

Append this test to `packages/dashboard/src/modules/traces/components/trace-latency-cell/trace-latency-cell.test.tsx`:

```tsx
test('colors duration from throughput when output tokens are large enough', () => {
  const view = render(<TraceLatencyCell durationMs={8_000} outputTokens={240} />);
  const durationDot = view.container.querySelector('[data-latency-dot]');

  expect(durationDot).toHaveClass('bg-primary');
  expect(durationDot).not.toHaveClass('bg-destructive');

  view.rerender(<TraceLatencyCell durationMs={8_000} outputTokens={100} />);
  expect(view.container.querySelector('[data-latency-dot]')).toHaveClass('bg-destructive');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun run --filter @aio-proxy/dashboard test:unit -- src/modules/traces/lib/trace-latency-grade/trace-latency-grade.test.ts src/modules/traces/components/trace-latency-cell/trace-latency-cell.test.tsx
```

Expected:
- grade helper tests FAIL: module missing.
- cell throughput test FAIL: 8s / 240 tokens still uses the old `< 3s` scale and is `bg-destructive`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/dashboard/src/modules/traces/lib/trace-latency-grade/trace-latency-grade.ts`:

```ts
import { cn } from '@aio-proxy/ui/lib/utils';

export type LatencyGrade = 'success' | 'warning' | 'danger';

export const firstResponseTimeGrade = (milliseconds: number): LatencyGrade => {
  const seconds = milliseconds / 1_000;
  if (seconds < 5) return 'success';
  if (seconds < 10) return 'warning';
  return 'danger';
};

export const responseTimeGrade = (milliseconds: number, outputTokens = 0): LatencyGrade => {
  const seconds = milliseconds / 1_000;
  if (outputTokens < 100 || seconds <= 0) return timeGrade(seconds);
  return throughputGrade(outputTokens / seconds);
};

export const latencyDotClassName = (grade: LatencyGrade): string =>
  cn(
    'size-1.5 rounded-full',
    grade === 'success' ? 'bg-primary' : grade === 'warning' ? 'bg-muted-foreground' : 'bg-destructive',
  );

const timeGrade = (seconds: number): LatencyGrade => {
  if (seconds < 10) return 'success';
  if (seconds < 30) return 'warning';
  return 'danger';
};

const throughputGrade = (tokensPerSecond: number): LatencyGrade => {
  if (tokensPerSecond >= 30) return 'success';
  if (tokensPerSecond >= 15) return 'warning';
  return 'danger';
};
```

Create `packages/dashboard/src/modules/traces/lib/trace-latency-grade/index.ts`:

```ts
export { firstResponseTimeGrade, latencyDotClassName, responseTimeGrade, type LatencyGrade } from './trace-latency-grade';
```

Replace `dotClassName` in `trace-latency-cell.tsx` with the helpers. The component must accept `outputTokens`:

```tsx
import { firstResponseTimeGrade, latencyDotClassName, responseTimeGrade } from '../../lib/trace-latency-grade';

interface TraceLatencyCellProps {
  readonly durationMs: number;
  readonly stream?: boolean | undefined;
  readonly ttftMs?: number | undefined;
  readonly fast?: boolean | undefined;
  readonly outputTokens?: number | undefined;
}

export const TraceLatencyCell: React.FC<TraceLatencyCellProps> = ({
  durationMs,
  stream = false,
  ttftMs,
  fast = false,
  outputTokens,
}) => (
  <div className="grid min-w-32 grid-cols-[0.375rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
    <span
      aria-hidden="true"
      className={latencyDotClassName(responseTimeGrade(durationMs, outputTokens ?? 0))}
      data-latency-dot
    />
    <span className="inline-flex items-center gap-1.5">
      {formatTraceDuration(durationMs)}
      {fast ? (
        <Zap aria-label={m['dashboard.traces.fast_latency']()} className="size-3 text-primary" data-fast-marker />
      ) : null}
    </span>
    {stream ? (
      <>
        {ttftMs === undefined ? (
          <span aria-hidden="true" />
        ) : (
          <span
            aria-hidden="true"
            className={latencyDotClassName(firstResponseTimeGrade(ttftMs))}
            data-latency-dot
          />
        )}
        <span className="text-xs text-muted-foreground">
          {TRACE_TTFT_LABEL} {ttftMs === undefined ? TRACE_PLACEHOLDER : formatTraceDuration(ttftMs)}
        </span>
      </>
    ) : null}
  </div>
);
```

Pass usage through from the table:

```tsx
      <TraceLatencyCell
        durationMs={row.original.durationMs}
        stream={row.original.stream}
        ttftMs={row.original.ttftMs}
        fast={row.original.fast}
        outputTokens={row.original.usage?.outputTokens}
      />
```

Create `.changeset/traces-fast-mode-marker.md` if it does not already exist. If a draft exists, replace it so it describes the shipped state of **both** behaviors:

```md
---
'@aio-proxy/types': patch
'@aio-proxy/core': patch
'@aio-proxy/server': patch
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

dashboard: grade traces latency like new-api and show the lightning icon for fast/priority requests
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
bun x oxfmt packages/dashboard/src/modules/traces/lib/trace-latency-grade packages/dashboard/src/modules/traces/components/trace-latency-cell packages/dashboard/src/modules/traces/components/traces-table/traces-table.tsx
bun run --filter @aio-proxy/dashboard test:unit -- src/modules/traces
```

Expected: PASS, including the 99 existing traces tests plus the new grade and throughput cases.

Also re-run the server/core fast-mode tests so the two behaviors still hold together:

```bash
bun run --filter @aio-proxy/server test:unit -- src/request-tracing/fast-mode/fast-mode.test.ts src/request-tracing/request-trace-recorder/request-trace-recorder.test.ts src/routes/pipeline/fast-mode.test.ts
bun run --filter @aio-proxy/core test:unit -- src/db/trace-store/trace-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/modules/traces/lib/trace-latency-grade packages/dashboard/src/modules/traces/components/trace-latency-cell packages/dashboard/src/modules/traces/components/traces-table/traces-table.tsx .changeset/traces-fast-mode-marker.md
git commit -m "$(cat <<'EOF'
dashboard: grade traces latency with new-api first-token and throughput thresholds

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

## Self-review

**Spec coverage**

- new-api TTFT `<5s / <10s` → Task 5 `firstResponseTimeGrade`
- new-api duration wall-clock `<10s / <30s` when `outputTokens < 100` → Task 5 `responseTimeGrade`
- new-api throughput `>=30 / >=15 t/s` when `outputTokens >= 100` → Task 5 `responseTimeGrade`
- existing three color tokens, dots only → Task 5 `latencyDotClassName`
- lightning from `service_tier=priority` OR `speed=fast` OR `anthropic-beta` includes `fast-mode-2026-02-01` → Tasks 1–4
- `service_tier=fast` does not light the icon → Task 1 negative cases
- persist boolean only, no raw header/body dump → Task 2
- no TPS column / timing bar / colored numbers → Global Constraints + Task 5 files

**Placeholder scan:** none. Every step has the actual test, command, and implementation.

**Type consistency:** `requestAsksFastMode` → `fastRequested` → `attributeName.fast` / `aio_proxy.request.fast` → `DashboardTraceSummary.fast` → `TraceLatencyCellProps.fast`. Duration coloring uses `outputTokens` from `usage.outputTokens`, default `0`.
