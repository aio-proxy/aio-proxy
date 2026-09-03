# Raw SSE `invalid_encrypted_content` Same-Candidate Retry

## Goal

When a same-protocol OpenAI Responses raw stream returns HTTP 200 and then an SSE `invalid_encrypted_content` error **before any generated content**, rewrite the outbound body once and replay the same candidate. The client must not see the failed stream.

## Background

Local production traces on 2026-09-03 (`trace_id` `bc8eaec9c6982bd5b7b13b70269e0298`, request `ac53f8ec-d50e-40e8-9d73-2aa8ec913c92`) show:

1. Codex Desktop subagent `POST /v1/responses` for `gpt-5.6-sol`, stream, inbound `openai-response`.
2. Protocol match, raw passthrough to `carpool`.
3. Upstream HTTP 200 SSE: `response.created`, then immediately:

```text
event: error
data: {"type":"error","error":{"type":"invalid_request_error","code":"invalid_encrypted_content","message":"Encrypted function output content could not be decrypted or decoded."}}
```

4. aio-proxy forwards that SSE. The client cancels. Trace is `failure` + HTTP 200. Nearby `gpt-5.6-sol` requests on `carpool` match.

Root cause: Codex puts spawn-agent plaintext in `encrypted_content` slots, and may also replay official reasoning blobs. Official OpenAI can decrypt those. A third-party Responses relay cannot. Cross-protocol transform already drops `encrypted_content`. Same-protocol raw forwards the body bytes.

`shouldFallbackStatus()` only treats `422` / `429` / `>= 500` as next-candidate fallback. HTTP 200 SSE errors never enter that gate. Model-path `preflightStream` and Antigravity `preflightCcaSse` already hold the first event before committing to the client. Raw OpenAI Responses does not.

`.reference` peers:

- CLIProxyAPI / opencodex rewrite spawn `encrypted_content` parts that are not backend ciphertext into `input_text`.
- sub2api retries **after** `invalid_encrypted_content` by dropping reasoning blobs. That works for HTTP 400. It cannot hide a 200 SSE error that already reached the client.

This change is the 200-SSE equivalent of sub2api's retry, with CLIProxyAPI's lossless spawn rewrite tried first.

## Behavior

The pipeline owns the candidate replay. The adapter owns every protocol-shaped judgement: which buffered frames are still undecided, and how to rewrite the outbound body. `completeRawAttempt` must not branch on `adapter.protocol`, parse OpenAI error envelopes, or edit an OpenAI wire payload.

### Adapter hook

Language adapters gain one optional field. An adapter without it keeps today's behavior exactly.

```ts
export type RawRetryFrame = { readonly event?: string; readonly data: string };
export type RawRetryVerdict = 'hold' | 'commit' | 'retry';

rawRetry?: Readonly<{
  // Classify one buffered SSE frame, or one JSON error body, before the
  // response is committed to the client. 'hold' keeps buffering.
  classify: (frame: RawRetryFrame) => RawRetryVerdict;
  // Rewritten upstream request, or undefined to commit the original response.
  rewrite: (upstream: Request, request: TRequest, context: TContext) => Promise<Request | undefined>;
}>;
```

`openAIResponsesAdapter` supplies it. `rewrite` returns `undefined` when `context.operation === 'compact'`, so the compact endpoint never replays.

### Classification is hold-by-default

`classify` must **not** treat every unfamiliar frame as `commit`. Pre-content metadata is normal: this repository's own Responses egress emits `response.output_item.added` immediately before each `response.output_text.delta` / `response.reasoning_summary_text.delta`, and `packages/server/src/passthrough-usage/content.ts` already classifies it as non-content. Committing on it would expose a metadata frame and make the very next `invalid_encrypted_content` impossible to hide, which is exactly the window this feature exists for.

`classifyOpenAIResponsesRawRetry` therefore commits only on a decisive frame:

| Frame | Verdict |
|---|---|
| `error` whose `error.code` is `invalid_encrypted_content` | `retry` |
| any other `error`, `response.failed`, `response.incomplete`, `response.cancelled` | `commit` |
| `response.completed`, `response.done` | `commit` |
| `response.output_text.delta`, `response.reasoning_text.delta`, `response.reasoning_summary_text.delta` | `commit` |
| `response.function_call_arguments.delta`, `response.custom_tool_call_input.delta` | `commit` |
| anything else, including `response.created`, `response.in_progress`, `response.output_item.added`, `response.content_part.added`, unparseable data | `hold` |

Holding an unknown frame is bounded by the 1 MiB replay cap, the preflight idle timer, and stream EOF, all of which commit. So an upstream that only ever emits frames this table does not name still reaches the client.

### Retry preconditions

- the attempt used raw passthrough
- the adapter exposes `rawRetry`
- the first upstream response is HTTP 200 `text/event-stream`, or HTTP 400 with a JSON content type
- `classify` returned `retry` before any frame classified `commit`
- `rewrite` returned a Request
- this candidate has not already been replayed

### SSE hold

For HTTP 200 event-stream with `rawRetry` present and `streamRequested` true, buffer bytes and feed frames to `classify` until a verdict. Do **not** return the Response to the client or call `usageCapture.passthrough` / `session.finishFrom` until then.

| Condition | Action |
|---|---|
| `classify` returns `hold` | keep buffering |
| `classify` returns `retry` | retryable; ask the adapter to rewrite |
| `classify` returns `commit` | commit: replay buffered bytes, then continue the upstream reader |
| stream ends while every frame held | commit |
| buffered bytes exceed 1 MiB | commit |
| no `rawRetry`, non-stream request, or non-event-stream body | commit without reading |

A `retry` verdict whose `rewrite` yields `undefined` commits the original error stream, so the client still sees the upstream error.

### Preflight liveness

The preflight read happens before `usageCapture.passthrough` installs the existing stream idle timer, so preflight carries its own guards. Both cancel the upstream reader and reject, which the attempt loop's existing exception path already maps to a provider failure (with next-candidate fallback) or, for an inbound abort, to `cancelled`.

- Idle: re-arm `createIdleTimer(STREAM_IDLE_TIMEOUT_MS)` on every chunk. A stream that emits a hold frame and then stalls must not hold the request, provider stream, and attempt span open.
- Inbound abort: register an `abort` listener on `rawRequest.signal` that cancels the reader **while a read is pending**. Polling `signal.aborted` between reads is not sufficient: once `reader.read()` is awaiting, a client disconnect would otherwise wait for upstream data or the 300s idle timer.

### HTTP 400

Interception is limited to a JSON content type, and the body is read with the same bounds the passthrough JSON capture uses: a 1 MiB cap (`MAX_PASSTHROUGH_JSON_BYTES`), the preflight idle timer, and the inbound abort listener. A non-JSON 400, an oversized body, or a body that never reaches EOF is streamed to the client unchanged, exactly as today.

On `classify({ data: bodyText }) === 'retry'` plus a rewrite, discard that body and invoke the same raw transport once with the rewritten request. This is not next-candidate fallback.

### Replay request

The retry Request must inherit the first upstream request's signal, so a client disconnect during the second invocation cancels it. Build it from the original Request (`new Request(upstreamClone, { method, headers, body, signal: upstream.signal })`), delete `content-length` / `content-encoding`, and clone the upstream Request before the first invoke so the retry still has body bytes.

### Rewrite (one retry, lossless first)

`openAIResponsesAdapter.rawRetry.rewrite` operates on the raw JSON `input` array of the **already rewritten** upstream request (model / background / effort already applied).

1. **Plaintext slots.** Every `{ type: "encrypted_content", encrypted_content: string }` part whose payload is **not** backend ciphertext becomes `{ type: "input_text", text: payload }` and loses `encrypted_content`. Walk `agent_message.content` and `function_call_output.output` when that output is an array. Leave ciphertext parts untouched.
2. If step 1 changed nothing, **opaque blobs.** Delete `encrypted_content` on `type: "reasoning"` and `type: "compaction"` / `compaction_summary` / `context_compaction` items. Keep the item and any `summary`.
3. If neither step changes the body, return `undefined`.

Backend ciphertext, copied from opencodex's cheap gate: string length `>= 64` and `/^[A-Za-z0-9+/=_-]+$/`. Do not add a Fernet decoder.

One retry maximum per candidate attempt. If the replay still errors, return that response to the client.

### Attempt accounting

The retry is the same candidate attempt. Do not open a second attempt span. Do not write cooldown. Do not fall through to the next candidate unless the **replay** status is already a `shouldFallbackStatus` value.

`usageCapture` and `session.finishFrom` observe only the response that is returned to the client.

## Scope

- Core: the `rawRetry` adapter hook, the OpenAI Responses `classify` / `rewrite` implementation, and the ciphertext gate.
- Server: a protocol-agnostic raw SSE preflight with idle and abort guards, the HTTP 400 intercept, and the same-candidate replay inside `completeRawAttempt` before usage capture.
- Tests for rewrite, classification, preflight liveness, and the raw pipeline retry.
- User-facing changeset on `aio-proxy`, `@aio-proxy/core`, and `@aio-proxy/server`.

## Non-goals

- Preemptive rewrite on the first send.
- Retry after any frame the adapter classified `commit`.
- Retry of failures other than `invalid_encrypted_content` (no other adapter supplies `rawRetry`).
- Next-candidate fallback for this error.
- `POST /v1/responses/compact`: `rewrite` returns `undefined` there.
- Changing the cross-protocol transform that already drops `encrypted_content`.
- A second retry when plaintext and blobs are both present.
- New dashboard events or trace attributes.

## Verification

- Spawn plaintext `encrypted_content` + 200 SSE `invalid_encrypted_content` after `response.created` must invoke raw twice, return only the second stream, and never expose the error frame.
- The same error after `response.output_item.added` but before any delta must still retry.
- The same error after an `output_text.delta` must not retry.
- Ciphertext-shaped `encrypted_content` parts must not be converted to `input_text`.
- Reasoning-only blobs retry by deleting `encrypted_content`, not by converting them to text.
- A stream that holds and then stalls must reject on the preflight idle timer instead of hanging.
- A client abort **after** a hold frame was consumed, while the next read is pending, must reject promptly rather than waiting for the idle timer.
- A client abort during the replay must cancel the replay.
- The compact route must not replay.
- A non-JSON `400` and an oversized JSON `400` must stream to the client without interception.
- An adapter without `rawRetry` must not read the body before committing.
- Ordinary raw `400` that is not this code, and raw `422`/`429`/`5xx` fallback, stay unchanged.
