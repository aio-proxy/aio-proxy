# Raw SSE Encrypted-Content Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide OpenAI Responses raw `invalid_encrypted_content` failures that arrive as HTTP 200 SSE (or HTTP 400 JSON) before any generated content, by rewriting the outbound body once and replaying the same candidate.

**Architecture:** Core owns the lossless-then-lossy JSON rewrite. Server holds the raw SSE until a decisive frame, then either commits those bytes to the client or cancels and invokes the same raw transport with the rewritten body. Usage capture and `session.finishFrom` see only the response that leaves the proxy.

**Tech Stack:** TypeScript, Bun test runner, `es-toolkit/predicate` `isPlainObject`, `eventsource-parser`, existing pipeline harness in `packages/server`.

**Spec:** [docs/superpowers/specs/2026-09-03-raw-sse-encrypted-content-retry-design.md](../specs/2026-09-03-raw-sse-encrypted-content-retry-design.md)

## Global Constraints

- The shared raw attempt must stay protocol-agnostic. No `adapter.protocol` branching, no OpenAI error parsing, and no OpenAI wire-payload editing in `packages/server/src/routes/pipeline/attempt/`.
- `classify` is hold-by-default. Commit only on a real content delta or a terminal frame. `response.output_item.added` and `response.content_part.added` hold, because the repo's own egress emits `output_item.added` immediately before every delta.
- Retry only when the adapter's `rawRetry.classify` says so. An adapter without `rawRetry` keeps today's behavior and must not have its body read before commit.
- `openAIResponsesAdapter.rawRetry.rewrite` returns `undefined` when `context.operation === 'compact'`.
- The preflight read carries `createIdleTimer(STREAM_IDLE_TIMEOUT_MS)` **and** an `abort` listener on `rawRequest.signal` that cancels the reader while a read is pending. Polling `signal.aborted` between reads is not enough.
- HTTP 400 interception is JSON-only and bounded by `MAX_PASSTHROUGH_JSON_BYTES` (1 MiB), the idle timer, and the abort listener. Anything else streams through untouched.
- The replay `Request` inherits `signal: upstream.signal`.
- One replay per candidate attempt. Same span. No cooldown. No next-candidate fallback unless the **replay** status already matches `shouldFallbackStatus`.
- Do not rewrite on the first send. Do not change the cross-protocol transform that already drops `encrypted_content`.
- Do not add a Fernet decoder. Ciphertext gate is length `>= 64` and `/^[A-Za-z0-9+/=_-]+$/`.
- New colocated unit-tested modules use a same-name directory: export-only `index.ts`, implementation, test.
- No new dependencies. `openai-responses.ts` (293 lines) and `raw.ts` (154 lines) must not pass 400 lines; put new logic in new files.
- Changeset must list `aio-proxy`, `@aio-proxy/core`, and `@aio-proxy/server` at the same `patch` level.
- Workspace is already an isolated git worktree. Do not create another worktree.

---

## File map

- `packages/core/src/protocol/adapter.ts` — add the optional `rawRetry` field to `LanguageProtocolAdapter`.
- `packages/core/src/protocol/openai-responses/encrypted-content-retry/index.ts` — export-only entry point.
- `packages/core/src/protocol/openai-responses/encrypted-content-retry/encrypted-content-retry.ts` — OpenAI Responses `classify` + `rewrite` + ciphertext gate.
- `packages/core/src/protocol/openai-responses/encrypted-content-retry/encrypted-content-retry.test.ts` — rewrite and classification contract.
- `packages/core/src/protocol/index.ts` — re-export the new unit.
- `packages/core/src/protocol/openai-responses.ts` — attach `rawRetry` to the adapter.
- `packages/server/src/usage-capture/index.ts` — export `createIdleTimer`, `STREAM_IDLE_TIMEOUT_MS`, `MAX_PASSTHROUGH_JSON_BYTES`.
- `packages/server/src/routes/pipeline/attempt/raw-retry/index.ts` — export-only entry point.
- `packages/server/src/routes/pipeline/attempt/raw-retry/raw-retry.ts` — protocol-agnostic preflight, bounded JSON read, replay resolution.
- `packages/server/src/routes/pipeline/attempt/raw-retry/raw-retry.test.ts` — verdict routing, idle timeout, pending-read abort, bounds, non-`rawRetry` passthrough.
- `packages/server/src/routes/pipeline/attempt/raw.ts` — call the replay resolver before usage capture.
- `packages/server/src/routes/pipeline/raw-encrypted-content-retry.test.ts` — pipeline: the client never sees the failed SSE.
- `.changeset/raw-sse-encrypted-content-retry.md` — release note.

`openai-responses.ts` stays where it is; the new collaborator lives in a sibling `openai-responses/` directory. Do not move the existing file in this change.

---

### Task 1: `rawRetry` adapter hook and OpenAI Responses implementation

**Files:**
- Modify: `packages/core/src/protocol/adapter.ts:75-86`
- Create: `packages/core/src/protocol/openai-responses/encrypted-content-retry/index.ts`
- Create: `packages/core/src/protocol/openai-responses/encrypted-content-retry/encrypted-content-retry.ts`
- Create: `packages/core/src/protocol/openai-responses/encrypted-content-retry/encrypted-content-retry.test.ts`
- Modify: `packages/core/src/protocol/index.ts:1-15`
- Modify: `packages/core/src/protocol/openai-responses.ts:96-99`

**Interfaces:**
- Consumes: `isPlainObject` from `es-toolkit/predicate`; `readRequestText` from `../../request`.
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
- Produces: `looksLikeBackendCiphertext(payload: string): boolean`, `classifyOpenAIResponsesRawRetry(frame: RawRetryFrame): RawRetryVerdict`, `rewriteOpenAIResponsesEncryptedContent(bodyText: string): string | undefined`, `openAIResponsesRawRetry: RawRetryHook<OpenAIResponsesRequest | OpenAIResponsesCompactRequest, OpenAIResponsesContext>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/protocol/openai-responses/encrypted-content-retry/encrypted-content-retry.test.ts`:

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

test('rejects short or punctuated payloads as ciphertext', () => {
  expect(looksLikeBackendCiphertext('delegated task')).toBe(false);
  expect(looksLikeBackendCiphertext('a'.repeat(64))).toBe(true);
  expect(looksLikeBackendCiphertext(CIPHER)).toBe(true);
  expect(looksLikeBackendCiphertext('A'.repeat(63))).toBe(false);
  expect(looksLikeBackendCiphertext(`${'A'.repeat(60)} hello`)).toBe(false);
});

test('retries only invalid_encrypted_content', () => {
  expect(classifyOpenAIResponsesRawRetry({ event: 'error', data: ENCRYPTED_ERROR })).toBe('retry');
  expect(classifyOpenAIResponsesRawRetry({ data: ENCRYPTED_ERROR })).toBe('retry');
  expect(
    classifyOpenAIResponsesRawRetry({ event: 'error', data: '{"type":"error","error":{"code":"invalid_value"}}' }),
  ).toBe('commit');
});

// The repo's own Responses egress sends response.output_item.added immediately
// before each delta, so committing on it would forfeit the retry window.
test.each([
  ['response.created', '{"type":"response.created"}'],
  ['response.in_progress', '{"type":"response.in_progress"}'],
  ['response.output_item.added', '{"type":"response.output_item.added","output_index":0}'],
  ['response.content_part.added', '{"type":"response.content_part.added"}'],
  [undefined, 'not-json'],
])('holds pre-content frame %s', (event, data) => {
  expect(classifyOpenAIResponsesRawRetry(event === undefined ? { data } : { event, data })).toBe('hold');
});

test.each([
  ['response.output_text.delta', '{"type":"response.output_text.delta","delta":"hi"}'],
  ['response.reasoning_text.delta', '{"type":"response.reasoning_text.delta","delta":"hi"}'],
  ['response.reasoning_summary_text.delta', '{"type":"response.reasoning_summary_text.delta","delta":"hi"}'],
  ['response.function_call_arguments.delta', '{"type":"response.function_call_arguments.delta","delta":"{"}'],
  ['response.completed', '{"type":"response.completed","response":{"status":"completed"}}'],
  ['response.failed', '{"type":"response.failed","response":{"status":"failed"}}'],
  ['response.incomplete', '{"type":"response.incomplete"}'],
])('commits decisive frame %s', (event, data) => {
  expect(classifyOpenAIResponsesRawRetry({ event, data })).toBe('commit');
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
  const source = new Request('https://upstream.test/v1/responses/compact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
  });
  expect(await openAIResponsesRawRetry.rewrite(source, {} as never, { operation: 'compact' })).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run:

```bash
bun test packages/core/src/protocol/openai-responses/encrypted-content-retry/encrypted-content-retry.test.ts
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

Create `packages/core/src/protocol/openai-responses/encrypted-content-retry/encrypted-content-retry.ts`:

```ts
import { isPlainObject } from 'es-toolkit/predicate';

import type { OpenAIResponsesCompactRequest } from '../../../ingress/openai-responses/compact';
import type { OpenAIResponsesRequest } from '../../../ingress/openai-responses/index';
import type { RawRetryFrame, RawRetryHook, RawRetryVerdict } from '../../adapter';
import { readRequestText } from '../../request';

type OpenAIResponsesRawRetryContext = { readonly operation?: 'create' | 'compact' };

const CIPHERTEXT = /^[A-Za-z0-9+/=_-]+$/;
const OPAQUE_ITEM_TYPES = new Set(['reasoning', 'compaction', 'compaction_summary', 'context_compaction']);
// Generated output. Once one of these reaches the client the stream is committed
// and a later error can no longer be hidden.
const CONTENT_EVENTS = new Set([
  'response.output_text.delta',
  'response.reasoning_text.delta',
  'response.reasoning_summary_text.delta',
  'response.function_call_arguments.delta',
  'response.custom_tool_call_input.delta',
]);
// Stream-level outcomes.
const TERMINAL_EVENTS = new Set([
  'response.completed',
  'response.done',
  'response.failed',
  'response.incomplete',
  'response.cancelled',
]);

export function looksLikeBackendCiphertext(payload: string): boolean {
  return payload.length >= 64 && CIPHERTEXT.test(payload);
}

// Hold-by-default. `response.output_item.added` and `response.content_part.added`
// are pre-content metadata: this repo's own egress emits output_item.added
// immediately before every delta, so committing there would forfeit the retry
// window this feature exists for. Unknown frames also hold; the 1 MiB replay
// cap, the preflight idle timer, and stream EOF all commit, so nothing hangs.
export function classifyOpenAIResponsesRawRetry(frame: RawRetryFrame): RawRetryVerdict {
  const payload = parseJson(frame.data);
  const type = frame.event ?? (typeof payload?.['type'] === 'string' ? payload['type'] : undefined);
  if (type !== undefined && CONTENT_EVENTS.has(type)) return 'commit';
  const error = isPlainObject(payload?.['error']) ? payload['error'] : undefined;
  if (type === 'error' || error !== undefined) {
    return error?.['code'] === 'invalid_encrypted_content' ? 'retry' : 'commit';
  }
  if (type !== undefined && TERMINAL_EVENTS.has(type)) return 'commit';
  return 'hold';
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

Create `packages/core/src/protocol/openai-responses/encrypted-content-retry/index.ts`:

```ts
export {
  classifyOpenAIResponsesRawRetry,
  looksLikeBackendCiphertext,
  openAIResponsesRawRetry,
  rewriteOpenAIResponsesEncryptedContent,
} from './encrypted-content-retry';
```

- [ ] **Step 5: Attach the hook and widen the barrel**

In `packages/core/src/protocol/openai-responses.ts`, add the import beside the other local imports:

```ts
import { openAIResponsesRawRetry } from './openai-responses/encrypted-content-retry';
```

Inside the `defineProtocolAdapter({ ... })` call, next to `errors: openAIResponsesErrors`, add:

```ts
  rawRetry: openAIResponsesRawRetry,
```

In `packages/core/src/protocol/index.ts`, add:

```ts
export * from './openai-responses/encrypted-content-retry';
```

`packages/core/src/index.ts` already does `export * from './protocol'`, so `classifyOpenAIResponsesRawRetry` and the hook types become part of the `@aio-proxy/core` surface the server consumes.

- [ ] **Step 6: Run the tests and confirm they pass**

Run:

```bash
bun test packages/core/src/protocol/openai-responses/encrypted-content-retry/encrypted-content-retry.test.ts packages/core/src/protocol/openai-responses.test.ts packages/core/src/protocol/openai-responses-basic.test.ts packages/core/src/protocol/openai-responses-compact.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  packages/core/src/protocol/adapter.ts \
  packages/core/src/protocol/index.ts \
  packages/core/src/protocol/openai-responses.ts \
  packages/core/src/protocol/openai-responses/encrypted-content-retry
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
- Create: `packages/server/src/routes/pipeline/attempt/raw-retry/index.ts`
- Create: `packages/server/src/routes/pipeline/attempt/raw-retry/raw-retry.ts`
- Create: `packages/server/src/routes/pipeline/attempt/raw-retry/raw-retry.test.ts`

**Interfaces:**
- Consumes: `RawRetryFrame`, `RawRetryVerdict` from `@aio-proxy/core`; `createParser` from `eventsource-parser`; `createIdleTimer`, `MAX_PASSTHROUGH_JSON_BYTES`, `STREAM_IDLE_TIMEOUT_MS` from `../../../../usage-capture`.
- Produces:

```ts
export type RawRetryPreflight =
  | { readonly kind: 'commit'; readonly response: Response }
  | { readonly kind: 'retry'; readonly response: Response };

export type RawRetryGuards = { readonly signal: AbortSignal; readonly idleTimeoutMs?: number };

export function preflightRawRetrySse(
  response: Response,
  classify: (frame: RawRetryFrame) => RawRetryVerdict,
  guards: RawRetryGuards,
): Promise<RawRetryPreflight>;

// undefined when the body is not JSON, exceeds the 1 MiB cap, or the read is
// cut short. Callers must stream the original response in that case.
export function readBoundedJsonBody(response: Response, guards: RawRetryGuards): Promise<string | undefined>;
```

`commit` replays every buffered byte then continues the upstream reader. `retry` also carries those bytes so the caller can forward the original error when no rewrite exists.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/routes/pipeline/attempt/raw-retry/raw-retry.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { classifyOpenAIResponsesRawRetry } from '@aio-proxy/core';

import { preflightRawRetrySse, readBoundedJsonBody } from './raw-retry';

const created =
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n';
const itemAdded =
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0}\n\n';
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

function heldStream(chunk: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunk));
    },
  });
}

test('holds lifecycle frames then reports retry', async () => {
  const preflight = await preflightRawRetrySse(sse(created + encryptedError), classifyOpenAIResponsesRawRetry, live());
  expect(preflight.kind).toBe('retry');
  expect(await preflight.response.text()).toBe(created + encryptedError);
});

test('still retries when output_item.added precedes the error', async () => {
  const preflight = await preflightRawRetrySse(
    sse(created + itemAdded + encryptedError),
    classifyOpenAIResponsesRawRetry,
    live(),
  );
  expect(preflight.kind).toBe('retry');
});

test('commits when content arrives before the error', async () => {
  const preflight = await preflightRawRetrySse(
    sse(created + itemAdded + delta + encryptedError),
    classifyOpenAIResponsesRawRetry,
    live(),
  );
  expect(preflight.kind).toBe('commit');
  expect(await preflight.response.text()).toBe(created + itemAdded + delta + encryptedError);
});

test('commits other SSE errors', async () => {
  const preflight = await preflightRawRetrySse(sse(created + otherError), classifyOpenAIResponsesRawRetry, live());
  expect(preflight.kind).toBe('commit');
});

test('commits a stream that only ever holds', async () => {
  const preflight = await preflightRawRetrySse(sse(created + itemAdded), classifyOpenAIResponsesRawRetry, live());
  expect(preflight.kind).toBe('commit');
  expect(await preflight.response.text()).toBe(created + itemAdded);
});

// One provider-controlled chunk can carry both the padding and the retryable
// error. The cap has to win, otherwise the replay bound is unenforceable.
test('commits when a single oversized chunk also carries the retryable error', async () => {
  const padding = `event: response.output_item.added\ndata: {"type":"response.output_item.added","note":"${'x'.repeat(1024 * 1024 + 16)}"}\n\n`;
  const preflight = await preflightRawRetrySse(
    sse(created + padding + encryptedError),
    classifyOpenAIResponsesRawRetry,
    live(),
  );
  expect(preflight.kind).toBe('commit');
});

test('passes a non-event-stream body through without reading it', async () => {
  const response = Response.json({ ok: true });
  const preflight = await preflightRawRetrySse(response, classifyOpenAIResponsesRawRetry, live());
  expect(preflight.kind).toBe('commit');
  expect(preflight.response).toBe(response);
  expect(await preflight.response.json()).toEqual({ ok: true });
});

test('rejects a stream that stalls after a hold frame', async () => {
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
    preflightRawRetrySse(response, classifyOpenAIResponsesRawRetry, {
      signal: new AbortController().signal,
      idleTimeoutMs: 10,
    }),
  ).rejects.toThrow();
  expect(cancelled).toBe(true);
});

// The abort must land while reader.read() is already pending: polling
// signal.aborted between reads would wait for upstream data or the idle timer.
test('rejects a delayed abort while the next read is pending', async () => {
  const controller = new AbortController();
  const response = new Response(heldStream(created), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  const pending = preflightRawRetrySse(response, classifyOpenAIResponsesRawRetry, {
    signal: controller.signal,
    idleTimeoutMs: 60_000,
  });
  await Bun.sleep(20);
  controller.abort();
  await expect(pending).rejects.toThrow();
});

test('reads a bounded JSON error body', async () => {
  const response = Response.json({ error: { code: 'invalid_encrypted_content' } }, { status: 400 });
  expect(await readBoundedJsonBody(response, live())).toBe('{"error":{"code":"invalid_encrypted_content"}}');
});

test('refuses a non-JSON body', async () => {
  const response = new Response('<html>gateway error</html>', {
    status: 400,
    headers: { 'content-type': 'text/html' },
  });
  expect(await readBoundedJsonBody(response, live())).toBeUndefined();
  expect(await response.text()).toBe('<html>gateway error</html>');
});

test('refuses an oversized JSON body', async () => {
  const huge = `{"error":{"message":"${'x'.repeat(1024 * 1024 + 16)}"}}`;
  const response = new Response(huge, { status: 400, headers: { 'content-type': 'application/json' } });
  expect(await readBoundedJsonBody(response, live())).toBeUndefined();
});

// The cloned inspection branch must be abandoned without awaiting the tee-wide
// cancellation: the preserved original branch is never drained here, so an
// awaited cancel would never settle.
test('resolves an oversized JSON read while the original body is still open', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoder.encode('x'.repeat(256 * 1024)));
    },
  });
  const response = new Response(body, { status: 400, headers: { 'content-type': 'application/json' } });

  const read = await Promise.race([
    readBoundedJsonBody(response, live()),
    Bun.sleep(1_000).then(() => 'timed-out' as const),
  ]);

  expect(read).toBeUndefined();
});

// A size or idle limit means "cannot intercept". An inbound abort is different:
// it must reach handleAttemptError so the request records `cancelled`.
test('rethrows an inbound abort during the JSON read', async () => {
  const controller = new AbortController();
  const response = new Response(heldStream('{"error":'), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
  const pending = readBoundedJsonBody(response, { signal: controller.signal, idleTimeoutMs: 60_000 });
  await Bun.sleep(20);
  controller.abort();
  await expect(pending).rejects.toThrow();
});

test('refuses a JSON body that stalls', async () => {
  const response = new Response(heldStream('{"error":'), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
  expect(await readBoundedJsonBody(response, { signal: new AbortController().signal, idleTimeoutMs: 10 })).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run:

```bash
bun test packages/server/src/routes/pipeline/attempt/raw-retry/raw-retry.test.ts --preload=packages/server/__tests__/setup.ts
```

Expected: FAIL with `Cannot find module './raw-retry'`.

- [ ] **Step 3: Export the shared bounds from the usage-capture barrel**

`createIdleTimer`, `STREAM_IDLE_TIMEOUT_MS`, and `MAX_PASSTHROUGH_JSON_BYTES` live in `packages/server/src/usage-capture/shared.ts` but are not re-exported. Add to `packages/server/src/usage-capture/index.ts`:

```ts
export {
  createIdleTimer,
  MAX_PASSTHROUGH_JSON_BYTES,
  STREAM_IDLE_TIMEOUT_MS,
  type IdleTimer,
} from './shared';
```

- [ ] **Step 4: Implement the preflight and the bounded JSON read**

Create `packages/server/src/routes/pipeline/attempt/raw-retry/raw-retry.ts`:

```ts
import type { RawRetryFrame, RawRetryVerdict } from '@aio-proxy/core';
import { createParser } from 'eventsource-parser';

import {
  createIdleTimer,
  MAX_PASSTHROUGH_JSON_BYTES,
  STREAM_IDLE_TIMEOUT_MS,
} from '../../../../usage-capture';

const MAX_PREFLIGHT_REPLAY_BYTES = 1024 * 1024;

function inboundAbortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError') as unknown as Error;
}

// Only an inbound abort must propagate. Size and idle limits mean "cannot
// intercept", and the caller streams the original response instead.
function isAbortFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export type RawRetryPreflight =
  | { readonly kind: 'commit'; readonly response: Response }
  | { readonly kind: 'retry'; readonly response: Response };

export type RawRetryGuards = { readonly signal: AbortSignal; readonly idleTimeoutMs?: number };

// Cancels `reader` on an inbound abort or an idle gap, so a pending read cannot
// outlive the client. usageCapture.passthrough installs the normal idle timer
// only after commit, which is why preflight needs its own.
function guardReader(reader: ReadableStreamDefaultReader<Uint8Array>, guards: RawRetryGuards) {
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    void reader.cancel(error).catch(() => undefined);
  };
  const idle = createIdleTimer(guards.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS, () => {
    fail(new Error('Upstream stream stalled before the raw retry verdict'));
  });
  const onAbort = () => fail(inboundAbortError());
  if (guards.signal.aborted) onAbort();
  else guards.signal.addEventListener('abort', onAbort, { once: true });
  return {
    arm: idle.arm,
    failure: () => failure,
    release: () => {
      idle.clear();
      guards.signal.removeEventListener('abort', onAbort);
    },
  };
}

export async function preflightRawRetrySse(
  response: Response,
  classify: (frame: RawRetryFrame) => RawRetryVerdict,
  guards: RawRetryGuards,
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
  const guard = guardReader(reader, guards);

  let done = false;
  try {
    guard.arm();
    while (verdict === 'hold' && !done) {
      const chunk = await reader.read();
      const failure = guard.failure();
      if (failure !== undefined) throw failure;
      guard.arm();
      done = chunk.done;
      if (chunk.value !== undefined) {
        buffered.push(chunk.value);
        bufferedBytes += chunk.value.byteLength;
        parser.feed(decoder.decode(chunk.value, { stream: true }));
        // The cap wins over whatever this chunk classified as. A single
        // provider-controlled chunk can be arbitrarily large and may carry the
        // retryable error itself, so checking `verdict === 'hold'` first would
        // let an oversized body through the advertised replay bound.
        if (bufferedBytes > MAX_PREFLIGHT_REPLAY_BYTES) verdict = 'commit';
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw guard.failure() ?? error;
  } finally {
    guard.release();
  }

  const next = new Response(replayBuffered(reader, buffered, done), {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
  return { kind: verdict === 'retry' ? 'retry' : 'commit', response: next };
}

export async function readBoundedJsonBody(
  response: Response,
  guards: RawRetryGuards,
): Promise<string | undefined> {
  const contentType = response.headers.get('content-type') ?? '';
  if (response.body === null || !contentType.toLowerCase().includes('application/json')) return undefined;

  // `response.clone()` tees the body. Never await a cancel on this branch: the
  // tee-wide promise does not settle until the preserved original branch is also
  // drained or cancelled, and the caller cannot return that original until this
  // function resolves. Awaiting would deadlock a large or never-ending 400.
  const reader = response.clone().body!.getReader();
  const abandon = () => {
    void reader.cancel().catch(() => undefined);
  };
  const guard = guardReader(reader, guards);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    guard.arm();
    for (;;) {
      const chunk = await reader.read();
      const failure = guard.failure();
      // An inbound abort is not a "cannot intercept" case: swallowing it would
      // make completeRawAttempt record an ordinary provider failure instead of
      // letting handleAttemptError see the cancellation.
      if (isAbortFailure(failure)) throw failure;
      if (failure !== undefined) return undefined;
      guard.arm();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_PASSTHROUGH_JSON_BYTES) {
        abandon();
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    abandon();
    if (isAbortFailure(error)) throw error;
    return undefined;
  } finally {
    guard.release();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
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

Create `packages/server/src/routes/pipeline/attempt/raw-retry/index.ts`:

```ts
export {
  preflightRawRetrySse,
  readBoundedJsonBody,
  type RawRetryGuards,
  type RawRetryPreflight,
} from './raw-retry';
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run:

```bash
bun test packages/server/src/routes/pipeline/attempt/raw-retry/raw-retry.test.ts --preload=packages/server/__tests__/setup.ts
```

Expected: PASS, including the stall, delayed-abort, non-JSON, oversized, and stalled-JSON cases.

- [ ] **Step 6: Commit**

```bash
git add \
  packages/server/src/usage-capture/index.ts \
  packages/server/src/routes/pipeline/attempt/raw-retry
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
- Modify: `packages/server/src/routes/pipeline/attempt/raw-retry/raw-retry.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/raw-retry/index.ts`
- Create: `packages/server/src/routes/pipeline/raw-encrypted-content-retry.test.ts`
- Create: `.changeset/raw-sse-encrypted-content-retry.md`

**Interfaces:**
- Consumes: `preflightRawRetrySse`, `readBoundedJsonBody` from `./raw-retry`.
- Consumes: `ctx.adapter.rawRetry`, `ctx.request`, `ctx.context`, `ctx.rawRequest.signal`, `ctx.streamRequested`.
- Produces: `resolveRawRetry(input): Promise<Response>` exported from `./raw-retry`, and `completeRawAttempt` still returning `AttemptStep`. On a hidden retry the second `raw.invoke` happens **before** `usageCapture.passthrough` and `session.finishFrom`.

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
const itemAdded =
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0}\n\n';
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
    return calls === 1 ? sse(created + itemAdded + encryptedError) : sse(success);
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true, input: spawnInput() }));
  const text = await response.text();

  expect(response.status).toBe(200);
  expect(text).toBe(success);
  expect(text).not.toContain('invalid_encrypted_content');
  expect(text).not.toContain('output_item.added');
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

test('streams a non-JSON 400 without interception', async () => {
  let calls = 0;
  const primary = responsesProvider(async () => {
    calls += 1;
    return new Response('<html>gateway error</html>', {
      status: 400,
      headers: { 'content-type': 'text/html' },
    });
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, input: spawnInput() }));

  expect(response.status).toBe(400);
  expect(calls).toBe(1);
  expect(await response.text()).toContain('gateway error');
});

// Cancellation happens before the second invoke, so a slow or throwing replay
// cannot leave the failed SSE connection open and buffering.
test('cancels the failed stream before invoking the replay', async () => {
  let cancelledBeforeReplay: boolean | undefined;
  let cancelled = false;
  let calls = 0;
  const primary = responsesProvider(async () => {
    calls += 1;
    if (calls === 1) {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(created + encryptedError));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    cancelledBeforeReplay = cancelled;
    throw new Error('replay transport failed');
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });

  await harness
    .run(jsonRequest({ model: REQUESTED_MODEL, stream: true, input: spawnInput() }))
    .catch(() => undefined);

  expect(calls).toBe(2);
  expect(cancelledBeforeReplay).toBe(true);
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
    .run(jsonRequest({ model: REQUESTED_MODEL, stream: true, input: spawnInput() }, { signal: controller.signal }))
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

- [ ] **Step 3: Add the replay resolver**

Append to `packages/server/src/routes/pipeline/attempt/raw-retry/raw-retry.ts`:

```ts
export type RawRetryResolution<TRequest, TContext> = {
  readonly hook:
    | Readonly<{
        classify: (frame: RawRetryFrame) => RawRetryVerdict;
        rewrite: (upstream: Request, request: TRequest, context: TContext) => Promise<Request | undefined>;
      }>
    | undefined;
  readonly retrySource: Request | undefined;
  readonly request: TRequest;
  readonly context: TContext;
  readonly response: Response;
  readonly streamRequested: boolean;
  readonly guards: RawRetryGuards;
  readonly invoke: (request: Request) => Promise<Response>;
};

// One replay at most, decided by the adapter. Runs before usage capture so a
// hidden retry never reaches the client or the trace.
export async function resolveRawRetry<TRequest, TContext>(
  input: RawRetryResolution<TRequest, TContext>,
): Promise<Response> {
  const { hook, retrySource, response } = input;
  if (hook === undefined || retrySource === undefined) return response;

  // Replay only after the failed response is released. A slow or throwing retry
  // transport would otherwise leave the first SSE reader locked and its upstream
  // connection open and buffering for the whole second call, and a thrown replay
  // would skip cancellation entirely.
  const replay = async (failed: Response): Promise<Response | undefined> => {
    const retryRequest = await hook.rewrite(retrySource, input.request, input.context);
    if (retryRequest === undefined) return undefined;
    void failed.body?.cancel().catch(() => undefined);
    return await input.invoke(retryRequest);
  };

  if (response.status === 400) {
    const bodyText = await readBoundedJsonBody(response, input.guards);
    if (bodyText === undefined || hook.classify({ data: bodyText }) !== 'retry') return response;
    return (await replay(response)) ?? response;
  }

  if (!response.ok || !input.streamRequested) return response;
  const preflight = await preflightRawRetrySse(response, hook.classify, input.guards);
  if (preflight.kind !== 'retry') return preflight.response;
  return (await replay(preflight.response)) ?? preflight.response;
}
```

Add `resolveRawRetry` and `type RawRetryResolution` to `packages/server/src/routes/pipeline/attempt/raw-retry/index.ts`.

- [ ] **Step 4: Call it from `completeRawAttempt`**

In `packages/server/src/routes/pipeline/attempt/raw.ts`, add:

```ts
import { resolveRawRetry } from './raw-retry';
```

Replace the single `raw.invoke` call with:

```ts
  const invokeRaw = async (request: Request): Promise<Response> => {
    const result = await inAttempt(adapter.protocol, () =>
      raw.invoke(request, logicalRequest, { upstreamStream: ctx.streamRequested }),
    );
    if (!(result instanceof Response)) throw new TypeError('Provider raw transport must return a Response');
    return result;
  };

  // `rawRetry` is absent on embedding adapters, and the clone must happen before
  // the first invoke consumes the body.
  const hook = 'rawRetry' in adapter ? adapter.rawRetry : undefined;
  const retrySource = hook === undefined ? undefined : upstream.clone();
  const response = await resolveRawRetry({
    hook,
    retrySource,
    request: ctx.request,
    context: ctx.context,
    response: await invokeRaw(upstream),
    streamRequested: ctx.streamRequested,
    guards: { signal: ctx.rawRequest.signal },
    invoke: invokeRaw,
  });
```

Delete the old `if (!(response instanceof Response)) throw ...` line, since `invokeRaw` now enforces that. Everything after this point — the `shouldFallbackStatus` check, cooldown, `usageCapture.passthrough`, and `session.finishFrom` — stays exactly as it is and runs on the resolved response.

- [ ] **Step 5: Re-run the raw suites**

Run:

```bash
bun test packages/server/src/routes/pipeline/raw-encrypted-content-retry.test.ts packages/server/src/routes/pipeline/raw-fallback.test.ts packages/server/src/routes/pipeline/raw-fallback.exceptions.test.ts packages/server/src/routes/pipeline/raw-session.test.ts --preload=packages/server/__tests__/setup.ts
```

Expected: all PASS, including the existing raw `400` terminal and `422`/`429`/`5xx` fallback contracts.

- [ ] **Step 6: Add the changeset**

Create `.changeset/raw-sse-encrypted-content-retry.md`:

```md
---
'aio-proxy': patch
'@aio-proxy/core': patch
'@aio-proxy/server': patch
---

Raw OpenAI Responses requests that fail with `invalid_encrypted_content` before any output are now retried once on the same provider. Plaintext encrypted slots become plain text, and opaque reasoning blobs are dropped when that is all that remains, so the client no longer sees a stream that disconnects before completion.
```

- [ ] **Step 7: Check and commit**

Run:

```bash
bun test packages/core/src/protocol/openai-responses/encrypted-content-retry/encrypted-content-retry.test.ts packages/server/src/routes/pipeline/attempt/raw-retry/raw-retry.test.ts packages/server/src/routes/pipeline/raw-encrypted-content-retry.test.ts --preload=packages/server/__tests__/setup.ts && bun run check
```

Expected: exit 0.

```bash
git add \
  packages/server/src/routes/pipeline/attempt/raw.ts \
  packages/server/src/routes/pipeline/attempt/raw-retry \
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

1. Spec coverage: the `rawRetry` hook and compact refusal (Task 1), hold-by-default classification including `output_item.added` (Task 1), SSE hold with idle plus pending-read abort guards, the 1 MiB cap winning over a same-chunk `retry`, the bounded JSON read with tee-safe abandonment and abort propagation, and non-`rawRetry` passthrough (Task 2), HTTP 400 interception limits, replay signal, cancel-before-replay, same-candidate accounting, no-rewrite commit, and the changeset (Task 3) each have a task. Non-goals are constraints, not extra tasks.
2. Placeholder scan: no TBD/TODO, no "add tests later", no "similar to Task N". Task 3 spells out the resolver instead of saying "wire it up".
3. Type consistency: `RawRetryFrame`, `RawRetryVerdict`, `RawRetryHook<TRequest, TContext>`, `RawRetryGuards`, `RawRetryPreflight`, `RawRetryResolution<TRequest, TContext>`, `classifyOpenAIResponsesRawRetry`, `rewriteOpenAIResponsesEncryptedContent`, `openAIResponsesRawRetry`, `preflightRawRetrySse(response, classify, guards)`, `readBoundedJsonBody(response, guards)`, `resolveRawRetry(input)`. Private helpers in `raw-retry.ts`: `guardReader`, `inboundAbortError`, `isAbortFailure`, `replayBuffered`. The pipeline calls only `hook.classify` and `hook.rewrite`.
