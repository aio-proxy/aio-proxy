# Raw SSE Encrypted-Content Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide OpenAI Responses raw `invalid_encrypted_content` failures that arrive as HTTP 200 SSE (or HTTP 400 JSON) before any generated content, by rewriting the outbound body once and replaying the same candidate.

**Architecture:** Core owns the lossless-then-lossy JSON rewrite. Server holds the raw SSE until a decisive frame, then either commits those bytes to the client or cancels and invokes the same raw transport with the rewritten body. Usage capture and `session.finishFrom` see only the response that leaves the proxy.

**Tech Stack:** TypeScript, Bun test runner, `es-toolkit/predicate` `isPlainObject`, `eventsource-parser`, existing pipeline harness in `packages/server`.

**Spec:** [docs/superpowers/specs/2026-09-03-raw-sse-encrypted-content-retry-design.md](../specs/2026-09-03-raw-sse-encrypted-content-retry-design.md)

## Global Constraints

- The shared raw attempt must stay protocol-agnostic. No `adapter.protocol` branching, no OpenAI error parsing, and no OpenAI wire-payload editing in `packages/server/src/routes/pipeline/attempt/`.
- Retry only when the adapter's `rawRetry.classify` says so. An adapter without `rawRetry` keeps today's behavior and must not have its body read before commit.
- `openAIResponsesAdapter.rawRetry.rewrite` returns `undefined` when `context.operation === 'compact'`.
- The preflight read carries its own `createIdleTimer(STREAM_IDLE_TIMEOUT_MS)` and honors `rawRequest.signal`. It runs before `usageCapture.passthrough` installs the normal idle timer.
- The replay `Request` inherits `signal: upstream.signal`.
- One replay per candidate attempt. Same span. No cooldown. No next-candidate fallback unless the **replay** status already matches `shouldFallbackStatus`.
- Do not rewrite on the first send. Do not change the cross-protocol transform that already drops `encrypted_content`.
- Do not add a Fernet decoder. Ciphertext gate is length `>= 64` and `/^[A-Za-z0-9+/=_-]+$/`.
- No new dependencies. `openai-responses.ts` (293 lines) and `raw.ts` (154 lines) must not pass 400 lines; put new logic in new files.
- Changeset must list `aio-proxy`, `@aio-proxy/core`, and `@aio-proxy/server` at the same `patch` level.
- Workspace is already an isolated git worktree. Do not create another worktree.

---

## File map

- `packages/core/src/protocol/adapter.ts` — add the optional `rawRetry` field to `LanguageProtocolAdapter`.
- `packages/core/src/protocol/openai-responses/encrypted-content-retry.ts` — OpenAI Responses `classify` + `rewrite` + ciphertext gate.
- `packages/core/src/protocol/openai-responses/encrypted-content-retry.test.ts` — rewrite and classification contract.
- `packages/core/src/protocol/openai-responses.ts` — attach `rawRetry` to the adapter.
- `packages/server/src/routes/pipeline/attempt/raw-retry-preflight.ts` — protocol-agnostic hold/commit/retry preflight with idle and abort guards.
- `packages/server/src/routes/pipeline/attempt/raw-retry-preflight.test.ts` — verdict routing, idle timeout, abort, non-`rawRetry` passthrough.
- `packages/server/src/routes/pipeline/attempt/raw.ts` — same-candidate replay before usage capture.
- `packages/server/src/routes/pipeline/raw-encrypted-content-retry.test.ts` — pipeline: the client never sees the failed SSE.
- `.changeset/raw-sse-encrypted-content-retry.md` — release note.

`openai-responses.ts` currently sits at `packages/core/src/protocol/openai-responses.ts` with tests beside it. The new collaborator goes in a `openai-responses/` directory next to it; do not move the existing file in this change.

---

### Task 1: `rawRetry` adapter hook and OpenAI Responses implementation

**Files:**
- Modify: `packages/core/src/protocol/adapter.ts:75-86`
- Create: `packages/core/src/protocol/openai-responses/encrypted-content-retry.ts`
- Create: `packages/core/src/protocol/openai-responses/encrypted-content-retry.test.ts`
- Modify: `packages/core/src/protocol/openai-responses.ts:96-99`

**Interfaces:**
- Consumes: `isPlainObject` from `es-toolkit/predicate`; `readRequestText` from `../request`.
- Produces (exported from `packages/core/src/protocol/adapter.ts`):

```ts
export type RawRetryFrame = { readonly event?: string; readonly data: string };
export type RawRetryVerdict = 'hold' | 'commit' | 'retry';
export type RawRetryHook<TRequest, TContext> = Readonly<{
  classify: (frame: RawRetryFrame) => RawRetryVerdict;
  rewrite: (upstream: Request, request: TRequest, context: TContext) => Promise<Request | undefined>;
}>;
```

- Produces: `LanguageProtocolAdapter.rawRetry?: RawRetryHook<TRequest, TContext>`.
- Produces (from `encrypted-content-retry.ts`): `looksLikeBackendCiphertext(payload: string): boolean`, `classifyOpenAIResponsesRawRetry(frame: RawRetryFrame): RawRetryVerdict`, `rewriteOpenAIResponsesEncryptedContent(bodyText: string): string | undefined`, and `openAIResponsesRawRetry: RawRetryHook<OpenAIResponsesRequest | OpenAIResponsesCompactRequest, OpenAIResponsesContext>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/protocol/openai-responses/encrypted-content-retry.test.ts`:

```ts
import { expect, test } from 'bun:test';

import {
  classifyOpenAIResponsesRawRetry,
  looksLikeBackendCiphertext,
  openAIResponsesRawRetry,
  rewriteOpenAIResponsesEncryptedContent,
} from './encrypted-content-retry';

const CIPHER = `g${'A'.repeat(63)}`;
const ENCRYPTED_ERROR = JSON.stringify({
  type: 'error',
  error: { type: 'invalid_request_error', code: 'invalid_encrypted_content', message: 'x' },
});

function upstream(body: unknown): Request {
  return new Request('https://upstream.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('rejects short or punctuated payloads as ciphertext', () => {
  expect(looksLikeBackendCiphertext('delegated task')).toBe(false);
  expect(looksLikeBackendCiphertext('a'.repeat(64))).toBe(true);
  expect(looksLikeBackendCiphertext(CIPHER)).toBe(true);
  expect(looksLikeBackendCiphertext('A'.repeat(63))).toBe(false);
  expect(looksLikeBackendCiphertext(`${'A'.repeat(60)} hello`)).toBe(false);
});

test('holds lifecycle frames and retries only invalid_encrypted_content', () => {
  expect(classifyOpenAIResponsesRawRetry({ event: 'response.created', data: '{"type":"response.created"}' })).toBe('hold');
  expect(classifyOpenAIResponsesRawRetry({ event: 'response.in_progress', data: '{}' })).toBe('hold');
  expect(classifyOpenAIResponsesRawRetry({ event: 'error', data: ENCRYPTED_ERROR })).toBe('retry');
  expect(classifyOpenAIResponsesRawRetry({ data: ENCRYPTED_ERROR })).toBe('retry');
  expect(
    classifyOpenAIResponsesRawRetry({
      event: 'error',
      data: '{"type":"error","error":{"code":"invalid_value"}}',
    }),
  ).toBe('commit');
  expect(
    classifyOpenAIResponsesRawRetry({
      event: 'response.output_text.delta',
      data: '{"type":"response.output_text.delta","delta":"hi"}',
    }),
  ).toBe('commit');
  expect(classifyOpenAIResponsesRawRetry({ event: 'response.output_item.added', data: '{}' })).toBe('commit');
  expect(classifyOpenAIResponsesRawRetry({ data: 'not-json' })).toBe('commit');
});

test('rewrites plaintext agent_message encrypted_content to input_text', () => {
  const body = JSON.stringify({
    model: 'gpt-5.6-sol',
    input: [
      {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/review_t1',
        content: [
          { type: 'input_text', text: 'Payload:\n' },
          { type: 'encrypted_content', encrypted_content: 'delegated task' },
        ],
      },
    ],
  });
  expect(JSON.parse(rewriteOpenAIResponsesEncryptedContent(body)!)).toEqual({
    model: 'gpt-5.6-sol',
    input: [
      {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/review_t1',
        content: [
          { type: 'input_text', text: 'Payload:\n' },
          { type: 'input_text', text: 'delegated task' },
        ],
      },
    ],
  });
});

test('rewrites plaintext function_call_output encrypted_content parts', () => {
  const body = JSON.stringify({
    input: [
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [{ type: 'encrypted_content', encrypted_content: 'tool result' }],
      },
    ],
  });
  expect(JSON.parse(rewriteOpenAIResponsesEncryptedContent(body)!).input[0].output).toEqual([
    { type: 'input_text', text: 'tool result' },
  ]);
});

test('leaves ciphertext parts untouched and falls through to the blob strip', () => {
  const body = JSON.stringify({
    input: [
      {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/w',
        content: [{ type: 'encrypted_content', encrypted_content: CIPHER }],
      },
      { type: 'reasoning', id: 'rs_1', encrypted_content: CIPHER, summary: [{ type: 'summary_text', text: 'think' }] },
    ],
  });
  expect(JSON.parse(rewriteOpenAIResponsesEncryptedContent(body)!)).toEqual({
    input: [
      {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/w',
        content: [{ type: 'encrypted_content', encrypted_content: CIPHER }],
      },
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'think' }] },
    ],
  });
});

test('strips reasoning and compaction blobs only when no plaintext slot changed', () => {
  const body = JSON.stringify({
    input: [
      { type: 'reasoning', encrypted_content: CIPHER, summary: [] },
      { type: 'compaction', encrypted_content: CIPHER },
      { type: 'compaction_summary', encrypted_content: CIPHER },
      { type: 'context_compaction', encrypted_content: CIPHER },
    ],
  });
  expect(JSON.parse(rewriteOpenAIResponsesEncryptedContent(body)!).input).toEqual([
    { type: 'reasoning', summary: [] },
    { type: 'compaction' },
    { type: 'compaction_summary' },
    { type: 'context_compaction' },
  ]);
});

test('returns undefined when there is nothing to rewrite', () => {
  expect(
    rewriteOpenAIResponsesEncryptedContent('{"input":[{"type":"message","role":"user","content":"hi"}]}'),
  ).toBeUndefined();
  expect(rewriteOpenAIResponsesEncryptedContent('not-json')).toBeUndefined();
});

test('hook rewrite carries the request forward and preserves the inbound signal', async () => {
  const controller = new AbortController();
  const source = new Request('https://upstream.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '5' },
    body: JSON.stringify({
      input: [
        {
          type: 'agent_message',
          author: '/root',
          recipient: '/root/w',
          content: [{ type: 'encrypted_content', encrypted_content: 'delegated task' }],
        },
      ],
    }),
    signal: controller.signal,
  });
  const retried = await openAIResponsesRawRetry.rewrite(source, {} as never, {});
  expect(retried).toBeDefined();
  expect(retried!.headers.get('content-length')).toBeNull();
  expect(retried!.signal.aborted).toBe(false);
  controller.abort();
  expect(retried!.signal.aborted).toBe(true);
  expect(await retried!.json()).toMatchObject({
    input: [{ type: 'agent_message', content: [{ type: 'input_text', text: 'delegated task' }] }],
  });
});

test('hook rewrite refuses the compact operation', async () => {
  const source = upstream({
    input: [
      {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/w',
        content: [{ type: 'encrypted_content', encrypted_content: 'delegated task' }],
      },
    ],
  });
  expect(await openAIResponsesRawRetry.rewrite(source, {} as never, { operation: 'compact' })).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run:

```bash
bun test packages/core/src/protocol/openai-responses/encrypted-content-retry.test.ts
```

Expected: FAIL with `Cannot find module './encrypted-content-retry'`.

- [ ] **Step 3: Add the hook type**

In `packages/core/src/protocol/adapter.ts`, above `SharedProtocolAdapter`, add:

```ts
export type RawRetryFrame = { readonly event?: string; readonly data: string };
export type RawRetryVerdict = 'hold' | 'commit' | 'retry';

// Lets one protocol adapter own the judgement for a same-protocol raw retry:
// which buffered frames are still undecided, and how to rewrite the outbound
// body. The pipeline owns the replay itself and stays protocol-agnostic.
export type RawRetryHook<TRequest, TContext> = Readonly<{
  classify: (frame: RawRetryFrame) => RawRetryVerdict;
  rewrite: (upstream: Request, request: TRequest, context: TContext) => Promise<Request | undefined>;
}>;
```

Inside the `LanguageProtocolAdapter` object type, next to `egressContext`, add:

```ts
    rawRetry?: RawRetryHook<TRequest, TContext>;
```

`rawRetry` is optional and `defineProtocolAdapter` spreads `definition`, so no default is needed.

- [ ] **Step 4: Implement the OpenAI Responses hook**

Create `packages/core/src/protocol/openai-responses/encrypted-content-retry.ts`:

```ts
import { isPlainObject } from 'es-toolkit/predicate';

import type { OpenAIResponsesCompactRequest } from '../../ingress/openai-responses/compact';
import type { OpenAIResponsesRequest } from '../../ingress/openai-responses/index';
import type { RawRetryFrame, RawRetryHook, RawRetryVerdict } from '../adapter';
import { readRequestText } from '../request';

type OpenAIResponsesRawRetryContext = { readonly operation?: 'create' | 'compact' };

const CIPHERTEXT = /^[A-Za-z0-9+/=_-]+$/;
const HOLD_EVENTS = new Set(['response.created', 'response.in_progress']);
const OPAQUE_ITEM_TYPES = new Set(['reasoning', 'compaction', 'compaction_summary', 'context_compaction']);

export function looksLikeBackendCiphertext(payload: string): boolean {
  return payload.length >= 64 && CIPHERTEXT.test(payload);
}

export function classifyOpenAIResponsesRawRetry(frame: RawRetryFrame): RawRetryVerdict {
  const payload = parseJson(frame.data);
  const type = frame.event ?? (typeof payload?.['type'] === 'string' ? payload['type'] : undefined);
  if (type !== undefined && HOLD_EVENTS.has(type)) return 'hold';
  const error = isPlainObject(payload?.['error']) ? payload['error'] : payload;
  return error?.['code'] === 'invalid_encrypted_content' ? 'retry' : 'commit';
}

export function rewriteOpenAIResponsesEncryptedContent(bodyText: string): string | undefined {
  const parsed = parseJson(bodyText);
  if (parsed === undefined || !Array.isArray(parsed['input'])) return undefined;

  const withPlaintext = rewritePlaintextSlots(parsed['input']);
  if (withPlaintext !== undefined) return JSON.stringify({ ...parsed, input: withPlaintext });

  const withBlobs = rewriteOpaqueBlobs(parsed['input']);
  if (withBlobs !== undefined) return JSON.stringify({ ...parsed, input: withBlobs });
  return undefined;
}

export const openAIResponsesRawRetry: RawRetryHook<
  OpenAIResponsesRequest | OpenAIResponsesCompactRequest,
  OpenAIResponsesRawRetryContext
> = {
  classify: classifyOpenAIResponsesRawRetry,
  async rewrite(upstream, _request, context) {
    // Compact replay is out of scope: its `input` can also be an array, so the
    // rewrite would otherwise fire on an endpoint this feature does not cover.
    if (context.operation === 'compact') return undefined;
    const body = rewriteOpenAIResponsesEncryptedContent(await readRequestText(upstream.clone()));
    if (body === undefined) return undefined;
    const headers = new Headers(upstream.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    // `signal` comes from the inbound request, so a client disconnect during the
    // replay cancels the second upstream call too.
    return new Request(upstream, { method: upstream.method, body, headers, signal: upstream.signal });
  },
};

function rewritePlaintextSlots(input: readonly unknown[]): unknown[] | undefined {
  let changed = false;
  const next = input.map((item) => {
    if (!isPlainObject(item)) return item;
    if (item['type'] === 'agent_message' && Array.isArray(item['content'])) {
      const content = rewriteParts(item['content']);
      if (content === undefined) return item;
      changed = true;
      return { ...item, content };
    }
    if (item['type'] === 'function_call_output' && Array.isArray(item['output'])) {
      const output = rewriteParts(item['output']);
      if (output === undefined) return item;
      changed = true;
      return { ...item, output };
    }
    return item;
  });
  return changed ? next : undefined;
}

function rewriteParts(parts: readonly unknown[]): unknown[] | undefined {
  let changed = false;
  const next = parts.map((part) => {
    if (!isPlainObject(part) || part['type'] !== 'encrypted_content' || typeof part['encrypted_content'] !== 'string') {
      return part;
    }
    if (looksLikeBackendCiphertext(part['encrypted_content'])) return part;
    changed = true;
    return { type: 'input_text', text: part['encrypted_content'] };
  });
  return changed ? next : undefined;
}

function rewriteOpaqueBlobs(input: readonly unknown[]): unknown[] | undefined {
  let changed = false;
  const next = input.map((item) => {
    if (!isPlainObject(item) || typeof item['type'] !== 'string' || !OPAQUE_ITEM_TYPES.has(item['type'])) return item;
    if (!Object.hasOwn(item, 'encrypted_content')) return item;
    changed = true;
    const { encrypted_content: _encrypted, ...rest } = item;
    return rest;
  });
  return changed ? next : undefined;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 5: Attach the hook to the adapter**

In `packages/core/src/protocol/openai-responses.ts`, add the import beside the other local imports:

```ts
import { openAIResponsesRawRetry } from './openai-responses/encrypted-content-retry';
```

Inside the `defineProtocolAdapter({ ... })` call, next to `errors: openAIResponsesErrors`, add:

```ts
  rawRetry: openAIResponsesRawRetry,
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run:

```bash
bun test packages/core/src/protocol/openai-responses/encrypted-content-retry.test.ts packages/core/src/protocol/openai-responses.test.ts packages/core/src/protocol/openai-responses-basic.test.ts packages/core/src/protocol/openai-responses-compact.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  packages/core/src/protocol/adapter.ts \
  packages/core/src/protocol/openai-responses.ts \
  packages/core/src/protocol/openai-responses/encrypted-content-retry.ts \
  packages/core/src/protocol/openai-responses/encrypted-content-retry.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add a raw retry hook for OpenAI Responses encrypted content

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 2: Protocol-agnostic raw retry preflight

**Files:**
- Modify: `packages/server/src/usage-capture/index.ts:1-10`
- Create: `packages/server/src/routes/pipeline/attempt/raw-retry-preflight.ts`
- Create: `packages/server/src/routes/pipeline/attempt/raw-retry-preflight.test.ts`

**Interfaces:**
- Consumes: `RawRetryFrame`, `RawRetryVerdict` from `@aio-proxy/core`; `createParser` from `eventsource-parser`; `createIdleTimer`, `STREAM_IDLE_TIMEOUT_MS` from `../../../usage-capture`. `packages/server/src/usage-capture/index.ts` currently exports only `captureImageUsage` and the `usage-capture` surface, so this task must widen that barrel.
- Produces:

```ts
export type RawRetryPreflight =
  | { readonly kind: 'commit'; readonly response: Response }
  | { readonly kind: 'retry'; readonly response: Response };

export function preflightRawRetry(
  response: Response,
  classify: (frame: RawRetryFrame) => RawRetryVerdict,
  options: { readonly signal: AbortSignal; readonly idleTimeoutMs?: number },
): Promise<RawRetryPreflight>;
```

A `commit` result replays every buffered byte, then continues the upstream reader. A `retry` result also carries those bytes so the caller can forward the original error when no rewrite exists. A stall or an inbound abort cancels the reader and rejects.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/routes/pipeline/attempt/raw-retry-preflight.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { classifyOpenAIResponsesRawRetry } from '@aio-proxy/core';

import { preflightRawRetry } from './raw-retry-preflight';

const created =
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n';
const encryptedError =
  'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","code":"invalid_encrypted_content","message":"x"}}\n\n';
const otherError = 'event: error\ndata: {"type":"error","error":{"code":"invalid_value"}}\n\n';
const delta = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n';

function sse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function live(): { readonly signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

test('holds lifecycle frames then reports retry', async () => {
  const preflight = await preflightRawRetry(sse(created + encryptedError), classifyOpenAIResponsesRawRetry, live());
  expect(preflight.kind).toBe('retry');
  expect(await preflight.response.text()).toBe(created + encryptedError);
});

test('commits when content arrives before the error', async () => {
  const preflight = await preflightRawRetry(
    sse(created + delta + encryptedError),
    classifyOpenAIResponsesRawRetry,
    live(),
  );
  expect(preflight.kind).toBe('commit');
  expect(await preflight.response.text()).toBe(created + delta + encryptedError);
});

test('commits other SSE errors', async () => {
  const preflight = await preflightRawRetry(sse(created + otherError), classifyOpenAIResponsesRawRetry, live());
  expect(preflight.kind).toBe('commit');
});

test('commits a stream that only ever holds', async () => {
  const preflight = await preflightRawRetry(sse(created), classifyOpenAIResponsesRawRetry, live());
  expect(preflight.kind).toBe('commit');
  expect(await preflight.response.text()).toBe(created);
});

test('passes a non-event-stream body through without reading it', async () => {
  const response = Response.json({ ok: true });
  const preflight = await preflightRawRetry(response, classifyOpenAIResponsesRawRetry, live());
  expect(preflight.kind).toBe('commit');
  expect(preflight.response).toBe(response);
  expect(await preflight.response.json()).toEqual({ ok: true });
});

test('fails a stream that stalls after a hold frame', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(created));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

  await expect(
    preflightRawRetry(response, classifyOpenAIResponsesRawRetry, { signal: new AbortController().signal, idleTimeoutMs: 10 }),
  ).rejects.toThrow();
  expect(cancelled).toBe(true);
});

test('fails when the inbound request aborts during the hold', async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode(created));
    },
  });
  const response = new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const pending = preflightRawRetry(response, classifyOpenAIResponsesRawRetry, { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toThrow();
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run:

```bash
bun test packages/server/src/routes/pipeline/attempt/raw-retry-preflight.test.ts --preload=packages/server/__tests__/setup.ts
```

Expected: FAIL with `Cannot find module './raw-retry-preflight'`.

- [ ] **Step 3: Export the idle timer from the usage-capture barrel**

`createIdleTimer` and `STREAM_IDLE_TIMEOUT_MS` live in `packages/server/src/usage-capture/shared.ts` but are not re-exported. Add to `packages/server/src/usage-capture/index.ts`:

```ts
export { createIdleTimer, STREAM_IDLE_TIMEOUT_MS, type IdleTimer } from './shared';
```

- [ ] **Step 4: Implement the preflight**

Create `packages/server/src/routes/pipeline/attempt/raw-retry-preflight.ts`:

```ts
import type { RawRetryFrame, RawRetryVerdict } from '@aio-proxy/core';
import { createParser } from 'eventsource-parser';

import { createIdleTimer, STREAM_IDLE_TIMEOUT_MS } from '../../../usage-capture';

const MAX_PREFLIGHT_REPLAY_BYTES = 1024 * 1024;

export type RawRetryPreflight =
  | { readonly kind: 'commit'; readonly response: Response }
  | { readonly kind: 'retry'; readonly response: Response };

export async function preflightRawRetry(
  response: Response,
  classify: (frame: RawRetryFrame) => RawRetryVerdict,
  options: { readonly signal: AbortSignal; readonly idleTimeoutMs?: number },
): Promise<RawRetryPreflight> {
  const contentType = response.headers.get('content-type') ?? '';
  if (response.body === null || !contentType.toLowerCase().includes('text/event-stream')) {
    return { kind: 'commit', response };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let verdict: RawRetryVerdict = 'hold';
  const parser = createParser({
    onEvent(event) {
      if (verdict !== 'hold') return;
      verdict = classify(event.event === undefined ? { data: event.data } : { event: event.event, data: event.data });
    },
  });

  // The normal 300s idle timer is installed by usageCapture.passthrough, which
  // has not run yet: without this guard an upstream that emits a lifecycle frame
  // and then stalls would hold the request and attempt span open indefinitely.
  let stalled: Error | undefined;
  const idle = createIdleTimer(options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS, () => {
    stalled = new Error('Upstream stream stalled during raw retry preflight');
    void reader.cancel(stalled).catch(() => undefined);
  });

  let done = false;
  try {
    idle.arm();
    while (verdict === 'hold' && !done) {
      if (options.signal.aborted) throw options.signal.reason;
      const chunk = await reader.read();
      if (stalled !== undefined) throw stalled;
      idle.arm();
      done = chunk.done;
      if (chunk.value !== undefined) {
        buffered.push(chunk.value);
        bufferedBytes += chunk.value.byteLength;
        parser.feed(decoder.decode(chunk.value, { stream: true }));
        if (verdict === 'hold' && bufferedBytes > MAX_PREFLIGHT_REPLAY_BYTES) verdict = 'commit';
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw stalled ?? error;
  } finally {
    idle.clear();
  }

  const next = new Response(replayBuffered(reader, buffered, done), {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
  return { kind: verdict === 'retry' ? 'retry' : 'commit', response: next };
}

function replayBuffered(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: readonly Uint8Array[],
  sourceDone: boolean,
): ReadableStream<Uint8Array> {
  let index = 0;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      reader.releaseLock();
    } catch {}
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < buffered.length) {
        controller.enqueue(buffered[index]!);
        index += 1;
        return;
      }
      if (sourceDone) {
        release();
        controller.close();
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) {
          release();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}
```

Export `classifyOpenAIResponsesRawRetry`, `RawRetryFrame`, `RawRetryHook`, and `RawRetryVerdict` from `packages/core/src/index.ts` if `bun run check` reports them missing from the `@aio-proxy/core` surface. `packages/core/src/index.ts` re-exports `./protocol` via `export * from './protocol'`, and `packages/core/src/protocol/index.ts` re-exports `./adapter` and `./openai-responses`; add `export * from './openai-responses/encrypted-content-retry';` to `packages/core/src/protocol/index.ts` so the hook and its classifier are reachable.

- [ ] **Step 5: Run the tests and confirm they pass**

Run:

```bash
bun test packages/server/src/routes/pipeline/attempt/raw-retry-preflight.test.ts --preload=packages/server/__tests__/setup.ts
```

Expected: PASS, including the stall and abort cases.

- [ ] **Step 6: Commit**

```bash
git add \
  packages/core/src/protocol/index.ts \
  packages/server/src/usage-capture/index.ts \
  packages/server/src/routes/pipeline/attempt/raw-retry-preflight.ts \
  packages/server/src/routes/pipeline/attempt/raw-retry-preflight.test.ts
git commit -m "$(cat <<'EOF'
feat(server): hold a raw stream until the adapter reaches a verdict

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 3: Same-candidate replay in `completeRawAttempt`

**Files:**
- Modify: `packages/server/src/routes/pipeline/attempt/raw.ts:52-86`
- Create: `packages/server/src/routes/pipeline/raw-encrypted-content-retry.test.ts`
- Create: `.changeset/raw-sse-encrypted-content-retry.md`

**Interfaces:**
- Consumes: `preflightRawRetry`, `RawRetryPreflight` from `./raw-retry-preflight`.
- Consumes: `ctx.adapter.rawRetry`, `ctx.request`, `ctx.context`, `ctx.rawRequest.signal`, `ctx.streamRequested`.
- Produces: `completeRawAttempt` still returns `AttemptStep`. On a hidden retry it calls `raw.invoke` a second time with the adapter's rewritten `Request` **before** `usageCapture.passthrough` and `session.finishFrom`.

- [ ] **Step 1: Write the failing pipeline tests**

Create `packages/server/src/routes/pipeline/raw-encrypted-content-retry.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { openAIResponsesAdapter } from '@aio-proxy/core';
import { ProviderProtocol } from '@aio-proxy/types';

import { jsonRequest, REQUESTED_MODEL, rawProvider, settleRecording } from '../../../__tests__/pipeline-helpers';
import { attemptsOf, pipeline } from './test-support';

const created =
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n';
const encryptedError =
  'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","code":"invalid_encrypted_content","message":"x"}}\n\n';
const success =
  created + 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n';

function sse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function spawnInput() {
  return [
    {
      type: 'agent_message',
      author: '/root',
      recipient: '/root/review_t1',
      content: [{ type: 'encrypted_content', encrypted_content: 'delegated task' }],
    },
  ];
}

function responsesProvider(invoke: (request: Request) => Promise<Response>) {
  return rawProvider({
    id: 'carpool',
    modelId: REQUESTED_MODEL,
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async (request) => invoke(request),
  });
}

test('replays the same raw candidate and hides the failed stream', async () => {
  let calls = 0;
  const bodies: unknown[] = [];
  const primary = responsesProvider(async (request) => {
    calls += 1;
    bodies.push(await request.clone().json());
    return calls === 1 ? sse(created + encryptedError) : sse(success);
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true, input: spawnInput() }));
  const text = await response.text();

  expect(response.status).toBe(200);
  expect(text).toBe(success);
  expect(text).not.toContain('invalid_encrypted_content');
  expect(calls).toBe(2);
  expect(bodies[1]).toMatchObject({
    input: [{ type: 'agent_message', content: [{ type: 'input_text', text: 'delegated task' }] }],
  });
  await settleRecording(harness.recording);
  expect(attemptsOf(harness.recording)).toEqual([{ outcome: 'success', providerId: 'carpool', statusCode: 200 }]);
});

test('does not retry after a content delta', async () => {
  let calls = 0;
  const primary = responsesProvider(async () => {
    calls += 1;
    return sse(
      created +
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
        encryptedError,
    );
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  const text = await (
    await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true, input: spawnInput() }))
  ).text();

  expect(calls).toBe(1);
  expect(text).toContain('invalid_encrypted_content');
});

test('retries HTTP 400 invalid_encrypted_content on the same candidate', async () => {
  let calls = 0;
  const primary = responsesProvider(async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json(
        { error: { type: 'invalid_request_error', code: 'invalid_encrypted_content', message: 'x' } },
        { status: 400 },
      );
    }
    return Response.json({ id: 'resp_ok', status: 'completed', output: [] });
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, input: spawnInput() }));

  expect(response.status).toBe(200);
  expect(calls).toBe(2);
  expect(await response.json()).toMatchObject({ id: 'resp_ok' });
});

test('commits the upstream error when no rewrite is possible', async () => {
  let calls = 0;
  const primary = responsesProvider(async () => {
    calls += 1;
    return sse(created + encryptedError);
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  const text = await (
    await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true, input: 'hello' }))
  ).text();

  expect(calls).toBe(1);
  expect(text).toContain('invalid_encrypted_content');
});

test('cancels the replay when the client disconnects', async () => {
  const controller = new AbortController();
  let replaySignal: AbortSignal | undefined;
  let calls = 0;
  const primary = responsesProvider(async (request) => {
    calls += 1;
    if (calls === 1) return sse(created + encryptedError);
    replaySignal = request.signal;
    controller.abort();
    return sse(success);
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  await harness
    .run(
      jsonRequest(
        { model: REQUESTED_MODEL, stream: true, input: spawnInput() },
        { signal: controller.signal },
      ),
    )
    .catch(() => undefined);

  expect(calls).toBe(2);
  expect(replaySignal?.aborted).toBe(true);
});
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run:

```bash
bun test packages/server/src/routes/pipeline/raw-encrypted-content-retry.test.ts --preload=packages/server/__tests__/setup.ts
```

Expected: FAIL. `calls` stays `1` and the client body contains `invalid_encrypted_content`.

- [ ] **Step 3: Wire the replay**

In `packages/server/src/routes/pipeline/attempt/raw.ts`, add:

```ts
import { preflightRawRetry } from './raw-retry-preflight';
```

Replace the single `raw.invoke` call in `completeRawAttempt` with a first invoke plus one resolution step, keeping `completeRawAttempt` as the orchestrator:

```ts
  const invokeRaw = (request: Request) =>
    inAttempt(adapter.protocol, () => raw.invoke(request, logicalRequest, { upstreamStream: ctx.streamRequested }));

  // Clone before the first invoke: the body is consumed by that call, and the
  // adapter's rewrite needs the original bytes.
  const retrySource = ctx.adapter.rawRetry === undefined ? undefined : upstream.clone();
  const first = await invokeRaw(upstream);
  if (!(first instanceof Response)) throw new TypeError('Provider raw transport must return a Response');
  const response = await resolveRawRetry(ctx, invokeRaw, retrySource, first);
```

Add `resolveRawRetry` as a private helper in the same file (move it to `raw-retry-preflight.ts` if `raw.ts` would pass 400 lines):

```ts
async function resolveRawRetry<TRequest, TContext>(
  ctx: AnyAttemptLoopContext<TRequest, TContext>,
  invokeRaw: (request: Request) => Promise<unknown>,
  retrySource: Request | undefined,
  response: Response,
): Promise<Response> {
  const hook = ctx.adapter.rawRetry;
  if (hook === undefined || retrySource === undefined) return response;

  const replay = async (): Promise<Response | undefined> => {
    const retryRequest = await hook.rewrite(retrySource, ctx.request, ctx.context);
    if (retryRequest === undefined) return undefined;
    const retried = await invokeRaw(retryRequest);
    if (!(retried instanceof Response)) throw new TypeError('Provider raw transport must return a Response');
    return retried;
  };

  if (response.status === 400) {
    const bodyText = await response.clone().text();
    if (hook.classify({ data: bodyText }) !== 'retry') return response;
    const retried = await replay();
    if (retried === undefined) return response;
    void response.body?.cancel().catch(() => undefined);
    return retried;
  }

  if (!response.ok || !ctx.streamRequested) return response;
  const preflight = await preflightRawRetry(response, hook.classify, { signal: ctx.rawRequest.signal });
  if (preflight.kind !== 'retry') return preflight.response;
  const retried = await replay();
  if (retried === undefined) return preflight.response;
  void preflight.response.body?.cancel().catch(() => undefined);
  return retried;
}
```

`ctx.adapter` is typed as a `PipelineAdapter` union whose embedding arm has no `rawRetry`; read it as `'rawRetry' in ctx.adapter ? ctx.adapter.rawRetry : undefined` if TypeScript rejects the direct access. Everything after this line — the `shouldFallbackStatus` check, cooldown, `usageCapture.passthrough`, and `session.finishFrom` — stays exactly as it is and now runs on the resolved response.

- [ ] **Step 4: Re-run the raw suites**

Run:

```bash
bun test packages/server/src/routes/pipeline/raw-encrypted-content-retry.test.ts packages/server/src/routes/pipeline/raw-fallback.test.ts packages/server/src/routes/pipeline/raw-fallback.exceptions.test.ts packages/server/src/routes/pipeline/raw-session.test.ts --preload=packages/server/__tests__/setup.ts
```

Expected: all PASS, including the existing raw `400` terminal and `422`/`429`/`5xx` fallback contracts.

- [ ] **Step 5: Add the changeset**

Create `.changeset/raw-sse-encrypted-content-retry.md`:

```md
---
'aio-proxy': patch
'@aio-proxy/core': patch
'@aio-proxy/server': patch
---

Raw OpenAI Responses requests that fail with `invalid_encrypted_content` before any output are now retried once on the same provider. Plaintext encrypted slots become plain text, and opaque reasoning blobs are dropped when that is all that remains, so the client no longer sees a stream that disconnects before completion.
```

- [ ] **Step 6: Check and commit**

Run:

```bash
bun test packages/core/src/protocol/openai-responses/encrypted-content-retry.test.ts packages/server/src/routes/pipeline/attempt/raw-retry-preflight.test.ts packages/server/src/routes/pipeline/raw-encrypted-content-retry.test.ts --preload=packages/server/__tests__/setup.ts && bun run check
```

Expected: exit 0.

```bash
git add \
  packages/server/src/routes/pipeline/attempt/raw.ts \
  packages/server/src/routes/pipeline/raw-encrypted-content-retry.test.ts \
  .changeset/raw-sse-encrypted-content-retry.md \
  docs/superpowers/specs/2026-09-03-raw-sse-encrypted-content-retry-design.md \
  docs/superpowers/plans/2026-09-03-raw-sse-encrypted-content-retry.md
git commit -m "$(cat <<'EOF'
fix(server): retry a raw attempt before committing its stream

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

## Self-review

1. Spec coverage: the `rawRetry` hook (Task 1), compact refusal (Task 1), SSE hold plus idle and abort guards (Task 2), non-`rawRetry` passthrough (Task 2), HTTP 400 intercept, replay signal, same-candidate accounting, no-rewrite commit, and the changeset (Task 3) each have a task. Non-goals are constraints, not extra tasks.
2. Placeholder scan: no TBD/TODO, no "add tests later", no "similar to Task N". Task 3 spells out the helper instead of saying "wire it up".
3. Type consistency: `RawRetryFrame`, `RawRetryVerdict`, `RawRetryHook<TRequest, TContext>`, `classifyOpenAIResponsesRawRetry`, `rewriteOpenAIResponsesEncryptedContent`, `openAIResponsesRawRetry`, `preflightRawRetry(response, classify, options)`, `RawRetryPreflight`. The pipeline calls only `hook.classify` and `hook.rewrite`.
