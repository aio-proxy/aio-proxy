# Raw SSE Encrypted-Content Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide OpenAI Responses raw `invalid_encrypted_content` failures that arrive as HTTP 200 SSE (or HTTP 400 JSON) before any generated content, by rewriting the outbound body once and replaying the same candidate.

**Architecture:** Core owns the lossless-then-lossy JSON rewrite. Server holds the raw SSE until a decisive frame, then either commits those bytes to the client or cancels and invokes the same raw transport with the rewritten body. Usage capture and `session.finishFrom` see only the response that leaves the proxy.

**Tech Stack:** TypeScript, Bun test runner, `es-toolkit/predicate` `isPlainObject`, `eventsource-parser`, existing pipeline harness in `packages/server`.

**Spec:** [docs/superpowers/specs/2026-09-03-raw-sse-encrypted-content-retry-design.md](../specs/2026-09-03-raw-sse-encrypted-content-retry-design.md)

## Global Constraints

- Retry only `invalid_encrypted_content`. No other SSE `error` codes.
- Retry only before generated content and before `response.output_item.added`.
- One replay per candidate attempt. Same span. No cooldown. No next-candidate fallback unless the **replay** status already matches `shouldFallbackStatus`.
- Do not rewrite on the first send. Do not change the cross-protocol transform that already drops `encrypted_content`.
- Do not add a Fernet decoder. Ciphertext gate is length `>= 64` and `/^[A-Za-z0-9+/=_-]+$/`.
- No new dependencies. `openai-responses.ts` (293 lines) and `raw.ts` (154 lines) must not grow past 400; put new logic in new files.
- Changeset must list `aio-proxy`, `@aio-proxy/core`, and `@aio-proxy/server` at the same `patch` level.
- Workspace is already an isolated git worktree. Do not create another worktree.

---

## File map

- `packages/core/src/transform/openai-responses/encrypted-content-retry.ts` — ciphertext gate + retry body rewrite.
- `packages/core/src/transform/openai-responses/encrypted-content-retry.test.ts` — rewrite contract.
- `packages/core/src/transform/openai-responses/index.ts` — re-export.
- `packages/core/src/index.ts` — public export for server.
- `packages/server/src/routes/pipeline/attempt/raw-sse-preflight.ts` — hold/commit/retryable classification and byte replay.
- `packages/server/src/routes/pipeline/attempt/raw-sse-preflight.test.ts` — frame classification.
- `packages/server/src/routes/pipeline/attempt/raw.ts` — same-candidate replay inside `completeRawAttempt` before usage capture.
- `packages/server/src/routes/pipeline/raw-encrypted-content-retry.test.ts` — pipeline: client never sees the failed SSE.
- `.changeset/raw-sse-encrypted-content-retry.md` — release note.

---

### Task 1: Retry body rewrite

**Files:**
- Create: `packages/core/src/transform/openai-responses/encrypted-content-retry.ts`
- Create: `packages/core/src/transform/openai-responses/encrypted-content-retry.test.ts`
- Modify: `packages/core/src/transform/openai-responses/index.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `isPlainObject` from `es-toolkit/predicate`.
- Produces: `looksLikeBackendCiphertext(payload: string): boolean`.
- Produces: `rewriteOpenAIResponsesEncryptedContentRetryBody(bodyText: string): string | undefined` — `undefined` means no retry body; otherwise a JSON string.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/transform/openai-responses/encrypted-content-retry.test.ts`:

```ts
import { expect, test } from 'bun:test';

import {
  looksLikeBackendCiphertext,
  rewriteOpenAIResponsesEncryptedContentRetryBody,
} from './encrypted-content-retry';

const CIPHER = `g${'A'.repeat(63)}`;

test('rejects short or punctuated payloads as ciphertext', () => {
  expect(looksLikeBackendCiphertext('delegated task')).toBe(false);
  expect(looksLikeBackendCiphertext('a'.repeat(64))).toBe(true);
  expect(looksLikeBackendCiphertext(CIPHER)).toBe(true);
  expect(looksLikeBackendCiphertext(`${'A'.repeat(63)}`)).toBe(false);
  expect(looksLikeBackendCiphertext(`${'A'.repeat(60)} hello`)).toBe(false);
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
  expect(JSON.parse(rewriteOpenAIResponsesEncryptedContentRetryBody(body)!)).toEqual({
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
  expect(JSON.parse(rewriteOpenAIResponsesEncryptedContentRetryBody(body)!).input[0].output).toEqual([
    { type: 'input_text', text: 'tool result' },
  ]);
});

test('leaves ciphertext-shaped encrypted_content parts untouched and falls through to blob strip', () => {
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
  expect(JSON.parse(rewriteOpenAIResponsesEncryptedContentRetryBody(body)!)).toEqual({
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
  expect(JSON.parse(rewriteOpenAIResponsesEncryptedContentRetryBody(body)!).input).toEqual([
    { type: 'reasoning', summary: [] },
    { type: 'compaction' },
    { type: 'compaction_summary' },
    { type: 'context_compaction' },
  ]);
});

test('returns undefined when there is nothing to rewrite', () => {
  expect(rewriteOpenAIResponsesEncryptedContentRetryBody('{"input":[{"type":"message","role":"user","content":"hi"}]}')).toBeUndefined();
  expect(rewriteOpenAIResponsesEncryptedContentRetryBody('not-json')).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run:

```bash
bun test packages/core/src/transform/openai-responses/encrypted-content-retry.test.ts
```

Expected: FAIL with `Cannot find module` or `rewriteOpenAIResponsesEncryptedContentRetryBody is not a function`.

- [ ] **Step 3: Implement the rewrite**

Create `packages/core/src/transform/openai-responses/encrypted-content-retry.ts`:

```ts
import { isPlainObject } from 'es-toolkit/predicate';

const CIPHERTEXT = /^[A-Za-z0-9+/=_-]+$/;
const OPAQUE_ITEM_TYPES = new Set(['reasoning', 'compaction', 'compaction_summary', 'context_compaction']);

export function looksLikeBackendCiphertext(payload: string): boolean {
  return payload.length >= 64 && CIPHERTEXT.test(payload);
}

export function rewriteOpenAIResponsesEncryptedContentRetryBody(bodyText: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed['input'])) return undefined;

  const withPlaintext = rewritePlaintextSlots(parsed['input']);
  if (withPlaintext) return JSON.stringify({ ...parsed, input: withPlaintext });

  const withBlobs = rewriteOpaqueBlobs(parsed['input']);
  if (withBlobs) return JSON.stringify({ ...parsed, input: withBlobs });
  return undefined;
}

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
```

Add to `packages/core/src/transform/openai-responses/index.ts`:

```ts
export { looksLikeBackendCiphertext, rewriteOpenAIResponsesEncryptedContentRetryBody } from './encrypted-content-retry';
```

Add a named export in `packages/core/src/index.ts` next to the other core exports:

```ts
export {
  looksLikeBackendCiphertext,
  rewriteOpenAIResponsesEncryptedContentRetryBody,
} from './transform/openai-responses/encrypted-content-retry';
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run:

```bash
bun test packages/core/src/transform/openai-responses/encrypted-content-retry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  packages/core/src/transform/openai-responses/encrypted-content-retry.ts \
  packages/core/src/transform/openai-responses/encrypted-content-retry.test.ts \
  packages/core/src/transform/openai-responses/index.ts \
  packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
feat(core): rewrite OpenAI Responses encrypted_content for raw retry

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 2: Raw SSE preflight

**Files:**
- Create: `packages/server/src/routes/pipeline/attempt/raw-sse-preflight.ts`
- Create: `packages/server/src/routes/pipeline/attempt/raw-sse-preflight.test.ts`

**Interfaces:**
- Consumes: `createParser` from `eventsource-parser`, `isPlainObject` from `es-toolkit/predicate`.
- Produces:

```ts
export type RawSsePreflight =
  | { readonly kind: 'commit'; readonly response: Response }
  | { readonly kind: 'retryable'; readonly code: 'invalid_encrypted_content'; readonly response: Response };

export function invalidEncryptedContentCode(value: unknown): 'invalid_encrypted_content' | undefined;
export async function preflightRawOpenAIResponsesSse(response: Response): Promise<RawSsePreflight>;
```

`preflightRawOpenAIResponsesSse` must not consume a non-event-stream body. A `commit` response replays every buffered byte then continues the upstream reader. A `retryable` response still carries those bytes so the caller can forward them if rewrite fails.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/routes/pipeline/attempt/raw-sse-preflight.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { invalidEncryptedContentCode, preflightRawOpenAIResponsesSse } from './raw-sse-preflight';

const created =
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n';
const encryptedError =
  'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","code":"invalid_encrypted_content","message":"Encrypted function output content could not be decrypted or decoded."}}\n\n';
const otherError = 'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","code":"invalid_value","message":"nope"}}\n\n';
const delta = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n';

function sse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('extracts invalid_encrypted_content from OpenAI error envelopes', () => {
  expect(
    invalidEncryptedContentCode({
      error: { type: 'invalid_request_error', code: 'invalid_encrypted_content', message: 'x' },
    }),
  ).toBe('invalid_encrypted_content');
  expect(invalidEncryptedContentCode({ error: { code: 'invalid_value' } })).toBeUndefined();
});

test('holds response.created then classifies invalid_encrypted_content as retryable', async () => {
  const preflight = await preflightRawOpenAIResponsesSse(sse(created + encryptedError));
  expect(preflight.kind).toBe('retryable');
  if (preflight.kind !== 'retryable') return;
  expect(preflight.code).toBe('invalid_encrypted_content');
  expect(await preflight.response.text()).toBe(created + encryptedError);
});

test('commits when a content delta arrives before the error', async () => {
  const preflight = await preflightRawOpenAIResponsesSse(sse(created + delta + encryptedError));
  expect(preflight.kind).toBe('commit');
  expect(await preflight.response.text()).toBe(created + delta + encryptedError);
});

test('commits other SSE errors', async () => {
  const preflight = await preflightRawOpenAIResponsesSse(sse(created + otherError));
  expect(preflight.kind).toBe('commit');
});

test('passes non-SSE bodies through', async () => {
  const response = Response.json({ ok: true });
  const preflight = await preflightRawOpenAIResponsesSse(response);
  expect(preflight.kind).toBe('commit');
  expect(await preflight.response.json()).toEqual({ ok: true });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run:

```bash
bun test packages/server/src/routes/pipeline/attempt/raw-sse-preflight.test.ts --preload=packages/server/__tests__/setup.ts
```

Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement preflight**

Create `packages/server/src/routes/pipeline/attempt/raw-sse-preflight.ts`:

```ts
import { isPlainObject } from 'es-toolkit/predicate';
import { createParser } from 'eventsource-parser';

const MAX_PREFLIGHT_REPLAY_BYTES = 1024 * 1024;
const HOLD_EVENTS = new Set(['response.created', 'response.in_progress']);
const CONTENT_EVENTS = new Set([
  'response.output_text.delta',
  'response.reasoning_text.delta',
  'response.reasoning_summary_text.delta',
]);

export type RawSsePreflight =
  | { readonly kind: 'commit'; readonly response: Response }
  | { readonly kind: 'retryable'; readonly code: 'invalid_encrypted_content'; readonly response: Response };

export function invalidEncryptedContentCode(value: unknown): 'invalid_encrypted_content' | undefined {
  if (!isPlainObject(value)) return undefined;
  const error = isPlainObject(value['error']) ? value['error'] : value;
  return error['code'] === 'invalid_encrypted_content' ? 'invalid_encrypted_content' : undefined;
}

export async function preflightRawOpenAIResponsesSse(response: Response): Promise<RawSsePreflight> {
  const contentType = response.headers.get('content-type') ?? '';
  if (response.body === null || !contentType.toLowerCase().includes('text/event-stream')) {
    return { kind: 'commit', response };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let decision: 'hold' | 'commit' | 'retryable' = 'hold';
  const parser = createParser({
    onEvent(event) {
      if (decision !== 'hold') return;
      const type = event.event || (isPlainObject(parseJson(event.data)) ? parseJson(event.data)?.['type'] : undefined);
      if (typeof type === 'string' && HOLD_EVENTS.has(type)) return;
      if (type === 'error' && invalidEncryptedContentCode(parseJson(event.data)) !== undefined) {
        decision = 'retryable';
        return;
      }
      decision = 'commit';
    },
  });

  let done = false;
  try {
    while (decision === 'hold' && !done) {
      const chunk = await reader.read();
      done = chunk.done;
      if (chunk.value !== undefined) {
        if (bufferedBytes + chunk.value.byteLength > MAX_PREFLIGHT_REPLAY_BYTES) {
          decision = 'commit';
        }
        buffered.push(chunk.value);
        bufferedBytes += chunk.value.byteLength;
        parser.feed(decoder.decode(chunk.value, { stream: true }));
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }

  const replay = replayBuffered(reader, buffered, done);
  const next = new Response(replay, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
  return decision === 'retryable' ? { kind: 'retryable', code: 'invalid_encrypted_content', response: next } : { kind: 'commit', response: next };
}

function replayBuffered(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: readonly Uint8Array[],
  sourceDone: boolean,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < buffered.length) {
        controller.enqueue(buffered[index]!);
        index += 1;
        return;
      }
      if (sourceDone) {
        reader.releaseLock();
        controller.close();
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) {
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
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

If `CONTENT_EVENTS` is unused after the generic "any non-hold frame commits" rule, do not leave it in the file. The tests already cover content-delta-before-error via the generic commit path.

- [ ] **Step 4: Run the tests and confirm they pass**

Run:

```bash
bun test packages/server/src/routes/pipeline/attempt/raw-sse-preflight.test.ts --preload=packages/server/__tests__/setup.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  packages/server/src/routes/pipeline/attempt/raw-sse-preflight.ts \
  packages/server/src/routes/pipeline/attempt/raw-sse-preflight.test.ts
git commit -m "$(cat <<'EOF'
feat(server): hold raw OpenAI Responses SSE until a retryable error

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 3: Same-candidate replay in `completeRawAttempt`

**Files:**
- Modify: `packages/server/src/routes/pipeline/attempt/raw.ts`
- Create: `packages/server/src/routes/pipeline/raw-encrypted-content-retry.test.ts`
- Create: `.changeset/raw-sse-encrypted-content-retry.md`

**Interfaces:**
- Consumes: `rewriteOpenAIResponsesEncryptedContentRetryBody` from `@aio-proxy/core`.
- Consumes: `preflightRawOpenAIResponsesSse`, `invalidEncryptedContentCode` from `./raw-sse-preflight`.
- Consumes: `ProviderProtocol` from `@aio-proxy/types`.
- Produces: `completeRawAttempt` still returns `AttemptStep`. On a hidden retry it invokes `raw.invoke` a second time with the rewritten `Request` **before** `usageCapture.passthrough` / `session.finishFrom`.

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
  'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","code":"invalid_encrypted_content","message":"Encrypted function output content could not be decrypted or decoded."}}\n\n';
const success =
  created + 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n';

function sse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function responsesRequest(input: unknown) {
  return jsonRequest({ model: REQUESTED_MODEL, stream: true, input });
}

test('replays the same raw candidate after SSE invalid_encrypted_content and hides the error frame', async () => {
  let calls = 0;
  const bodies: unknown[] = [];
  const primary = rawProvider({
    id: 'carpool',
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async (request) => {
      calls += 1;
      bodies.push(await request.clone().json());
      return calls === 1 ? sse(created + encryptedError) : sse(success);
    },
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });
  const response = await harness.run(
    responsesRequest([
      {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/review_t1',
        content: [{ type: 'encrypted_content', encrypted_content: 'delegated task' }],
      },
    ]),
  );

  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toBe(success);
  expect(text).not.toContain('invalid_encrypted_content');
  expect(calls).toBe(2);
  expect(bodies[1]).toMatchObject({
    input: [
      {
        type: 'agent_message',
        content: [{ type: 'input_text', text: 'delegated task' }],
      },
    ],
  });
  await settleRecording(harness.recording);
  expect(attemptsOf(harness.recording)).toEqual([{ outcome: 'success', providerId: 'carpool', statusCode: 200 }]);
});

test('does not retry after a content delta', async () => {
  let calls = 0;
  const primary = rawProvider({
    id: 'carpool',
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async () => {
      calls += 1;
      return sse(
        created +
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
          encryptedError,
      );
    },
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });
  const text = await (
    await harness.run(
      responsesRequest([
        {
          type: 'agent_message',
          author: '/root',
          recipient: '/root/w',
          content: [{ type: 'encrypted_content', encrypted_content: 'delegated task' }],
        },
      ]),
    )
  ).text();
  expect(calls).toBe(1);
  expect(text).toContain('invalid_encrypted_content');
});

test('retries HTTP 400 invalid_encrypted_content on the same candidate', async () => {
  let calls = 0;
  const primary = rawProvider({
    id: 'carpool',
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json(
          { error: { type: 'invalid_request_error', code: 'invalid_encrypted_content', message: 'x' } },
          { status: 400 },
        );
      }
      return Response.json({ id: 'resp_ok', status: 'completed', output: [] });
    },
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });
  const response = await harness.run(
    jsonRequest({
      model: REQUESTED_MODEL,
      input: [
        {
          type: 'agent_message',
          author: '/root',
          recipient: '/root/w',
          content: [{ type: 'encrypted_content', encrypted_content: 'delegated task' }],
        },
      ],
    }),
  );
  expect(response.status).toBe(200);
  expect(calls).toBe(2);
  expect(await response.json()).toMatchObject({ id: 'resp_ok' });
});
```

Use `REQUESTED_MODEL` only if the test adapter/provider model id matches `openAIResponsesAdapter` routing. If the harness 404s, set `rawProvider({ modelId: REQUESTED_MODEL, ...})` or put `model: primary.provider` alias into the JSON body. The existing `raw-fallback.test.ts` uses `REQUESTED_MODEL` with the default test adapter; this file uses `openAIResponsesAdapter`, so pin `modelId: REQUESTED_MODEL` on `rawProvider` if the first run 404s.

- [ ] **Step 2: Run the new tests and confirm they fail**

Run:

```bash
bun test packages/server/src/routes/pipeline/raw-encrypted-content-retry.test.ts --preload=packages/server/__tests__/setup.ts
```

Expected: FAIL. `calls === 1` and the client body contains `invalid_encrypted_content`.

- [ ] **Step 3: Wire the replay**

In `packages/server/src/routes/pipeline/attempt/raw.ts`, import:

```ts
import { rewriteOpenAIResponsesEncryptedContentRetryBody } from '@aio-proxy/core';
import { ProviderProtocol } from '@aio-proxy/types';
import { invalidEncryptedContentCode, preflightRawOpenAIResponsesSse } from './raw-sse-preflight';
```

Inside `completeRawAttempt`, replace the single `raw.invoke` with a helper in the same file (keep `completeRawAttempt` as the orchestrator; if the file would exceed 400 lines, move the helper into `raw-sse-preflight.ts` as `replayRawOpenAIResponsesEncryptedContent`).

Required control flow:

```ts
const response = await invokeRaw(upstream);
const resolved = await resolveEncryptedContentRetry(ctx, raw, upstream, response, inAttempt);
```

`resolveEncryptedContentRetry`:

1. If `adapter.protocol !== ProviderProtocol.OpenAIResponse`, return `response`.
2. If status is 400, parse JSON (clone), and if `invalidEncryptedContentCode` matches, `rewrite` the **upstream** body. On a new body, cancel the 400 body and `invokeRaw` the rewritten `Request` once. Return that.
3. If status is 200, `preflightRawOpenAIResponsesSse`. If `commit`, return `preflight.response`. If `retryable`, rewrite the upstream body. On a new body, cancel `preflight.response`, `invokeRaw` the rewritten `Request` once, and if that is 200 SSE, return `preflightRawOpenAIResponsesSse(second).response` (never retry again). If rewrite is `undefined`, return `preflight.response` so the original error frames still reach the client.
4. Reconstruct the retry `Request` from the first `upstream` URL/method/headers, replacing body and deleting `content-length` / `content-encoding`. Read the first upstream body with `upstream.clone().text()` **before** the first invoke, or clone the `Request` before invoke, so the retry still has bytes.

Do not call `usageCapture.passthrough` or `session.finishFrom` until this helper returns. Existing fallback / cooldown / success code then runs on the resolved response unchanged.

- [ ] **Step 4: Re-run the pipeline tests**

Run:

```bash
bun test packages/server/src/routes/pipeline/raw-encrypted-content-retry.test.ts packages/server/src/routes/pipeline/raw-fallback.test.ts --preload=packages/server/__tests__/setup.ts
```

Expected: all PASS, including the existing raw `400` / `422` fallback cases.

- [ ] **Step 5: Add the changeset**

Create `.changeset/raw-sse-encrypted-content-retry.md`:

```md
---
'aio-proxy': patch
'@aio-proxy/core': patch
'@aio-proxy/server': patch
---

Raw OpenAI Responses streams that fail with `invalid_encrypted_content` before any output are retried once on the same provider after rewriting plaintext encrypted slots (and opaque reasoning blobs if that is all that remains). The client never sees the failed SSE.
```

- [ ] **Step 6: Check and commit**

Run:

```bash
bun test packages/core/src/transform/openai-responses/encrypted-content-retry.test.ts packages/server/src/routes/pipeline/attempt/raw-sse-preflight.test.ts packages/server/src/routes/pipeline/raw-encrypted-content-retry.test.ts packages/server/src/routes/pipeline/raw-fallback.test.ts --preload=packages/server/__tests__/setup.ts && bun run check
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
fix(server): retry raw Responses invalid_encrypted_content before commit

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

## Self-review

1. Spec coverage: SSE hold table, HTTP 400, plaintext-then-blob rewrite, ciphertext gate, one retry, same-candidate accounting, no next-candidate fallback, verification cases, and changeset each have a task. Non-goals are constraints, not extra tasks.
2. Placeholder scan: no TBD/TODO, no "add tests later", no "similar to Task N". Task 3 names the exact helper flow instead of "wire it up".
3. Type consistency: `rewriteOpenAIResponsesEncryptedContentRetryBody(bodyText: string): string | undefined`, `RawSsePreflight`, `invalidEncryptedContentCode`, `preflightRawOpenAIResponsesSse(response: Response): Promise<RawSsePreflight>`.
