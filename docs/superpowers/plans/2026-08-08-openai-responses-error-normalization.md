# OpenAI Responses Error Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex receive upstream top-level Responses `error` events as `response.failed` events with the original error code and message.

**Architecture:** Keep the existing OpenAI SSE terminal parser as the single wire parser. While it already classifies complete frames, retain the `response` object from `response.created`; when a terminal top-level `error` arrives, replace only that frame with a protocol-shaped `response.failed` frame whose failed response reuses the created response and nests the original error details. All successful and already-valid terminal frames remain byte-identical.

**Tech Stack:** Bun, TypeScript, Web Streams, `eventsource-parser`, Bun test.

## Global Constraints

- Do not change `/v1/models` or model metadata behavior; that design is tracked in GitHub issue #169.
- Do not add a second SSE parser, whole-stream buffering, retry, fallback, or dependency.
- Preserve byte-identical forwarding for non-error frames and already-valid terminal events.
- Normalize only OpenAI Responses top-level `error` events after a usable `response.created` event.
- Preserve upstream `type`, `code`, `message`, `param`, and other JSON-safe error fields inside `response.error`.

---

### Task 1: Normalize top-level Responses errors

**Files:**
- Modify: `packages/plugin-sdk/src/openai-stream/sse-terminal.ts`
- Test: `packages/plugin-sdk/src/openai-stream/sse-terminal.recognition.test.ts`

**Interfaces:**
- Consumes: existing `createOpenAISseBody(decoded, 'openai-response')` and complete parsed SSE frames.
- Produces: the same `ReadableStream<Uint8Array>`, with a top-level `error` terminal replaced by one `response.failed` SSE frame when a prior `response.created` supplied a response object.

- [x] **Step 1: Write the failing behavior test**

Add a test that feeds these two frames through the real `createOpenAISseBody` stream:

```text
event: response.created
data: {"type":"response.created","response":{"id":"resp_1","object":"response","status":"in_progress"}}

event: error
data: {"type":"error","code":"context_too_large","message":"Your input exceeds the context window of this model.","param":null,"sequence_number":0}

```

Parse the second emitted frame and assert literal behavior:

```ts
expect(eventName).toBe('response.failed');
expect(payload.type).toBe('response.failed');
expect(payload.response).toMatchObject({
  id: 'resp_1',
  object: 'response',
  status: 'failed',
  error: {
    type: 'error',
    code: 'context_too_large',
    message: 'Your input exceeds the context window of this model.',
    param: null,
  },
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
rtk bun test packages/plugin-sdk/src/openai-stream/sse-terminal.recognition.test.ts
```

Expected: FAIL because the second frame is still `event: error` with a top-level error payload.

- [x] **Step 3: Implement the minimum frame normalization**

In `createOpenAISseBody`:

1. retain the parsed `response` object from a valid `response.created` frame;
2. for an OpenAI Responses terminal whose event/data type is `error`, parse the object payload;
3. emit one UTF-8 SSE frame with `event: response.failed` and data:

```ts
{
  type: 'response.failed',
  sequence_number: upstream.sequence_number,
  response: {
    ...createdResponse,
    status: 'failed',
    error: upstream,
  },
}
```

Destructure `sequence_number` from the top-level error: retain it on the `response.failed` event and place every remaining upstream field in `response.error`. If the frame is malformed or no created response was observed, preserve the original frame rather than fabricating an invalid response.

- [x] **Step 4: Run focused plugin-sdk tests and verify GREEN**

Run:

```bash
rtk bun test packages/plugin-sdk/src/openai-stream/sse-terminal.recognition.test.ts packages/plugin-sdk/src/openai-stream/sse-terminal.batching.test.ts packages/plugin-sdk/src/openai-stream/sse-terminal-review.test.ts packages/plugin-sdk/src/openai-stream/openai-stream-fetch.response.test.ts
```

Expected: PASS with no warnings.

### Task 2: Release note and verification

**Files:**
- Create: `.changeset/spicy-breads-rule.md`
- Verify: all files changed by Task 1

**Interfaces:**
- Consumes: the normalized stream behavior from Task 1.
- Produces: patch release notes for `@aio-proxy/plugin-sdk` and `aio-proxy`.

- [x] **Step 1: Add a patch changeset**

Run `rtk bun changeset` and select both `@aio-proxy/plugin-sdk` and `aio-proxy` as patch releases. Use this release note:

```text
Normalize early OpenAI Responses error events into response.failed events so Codex surfaces the upstream error instead of reporting a generic disconnected stream.
```

- [x] **Step 2: Run repository checks**

Run:

```bash
rtk bun run check
rtk bun run preflight
```

Observed: `bun run check` exits 0 and all 32 test/artifact tasks pass. `bun run preflight` stops in the pre-existing `website/theme/env.d.ts` type declarations (`TS2411` and `TS2717`) before its test phase; the changed plugin-sdk source has no type-aware lint errors.

- [x] **Step 3: Inspect the final diff**

Run:

```bash
rtk git diff --check
rtk git status --short
```

Expected: only the plan, one plugin-sdk source file, its existing colocated test, and one changeset are modified; `.aio-proxy-dev` remains the pre-existing untracked symlink.
