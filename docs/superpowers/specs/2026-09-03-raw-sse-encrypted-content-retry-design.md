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

Applies only when all of these are true:

- inbound adapter protocol is `openai-response`
- the attempt used raw passthrough
- the first upstream response is either HTTP 200 `text/event-stream` or HTTP 400 JSON
- the error code is exactly `invalid_encrypted_content`
- no generated content has been observed
- a rewrite of the outbound JSON body actually changes something
- this candidate has not already been replayed for this reason

### SSE hold

For HTTP 200 event-stream, buffer bytes until the first decisive frame. Do **not** return the Response to the client or call `usageCapture.passthrough` / `session.finishFrom` until that decision.

| Frame | Action |
|---|---|
| `response.created`, `response.in_progress` | hold, keep buffering |
| `event: error` and `error.code === "invalid_encrypted_content"` | retryable, cancel upstream, do not replay buffered bytes |
| other `event: error` / `response.failed` / `response.incomplete` | commit: replay buffered bytes to the client |
| content delta (`response.output_text.delta`, `response.reasoning_text.delta`, `response.reasoning_summary_text.delta`) | commit |
| `response.output_item.added` or any other non-hold frame | commit |
| stream ends with only hold frames | commit |
| buffered bytes exceed 1 MiB before a decision | commit |

A retryable decision that cannot rewrite the body becomes commit of the original error stream.

### HTTP 400

If the first response is HTTP 400 JSON with `error.code === "invalid_encrypted_content"` and a rewrite changes the body, cancel/ignore that body and invoke the same raw transport once with the rewritten request. Do not treat this as next-candidate fallback.

### Rewrite (one retry, lossless first)

Operate on the raw JSON `input` array of the **already rewritten** upstream request (model / background / effort already applied).

1. **Plaintext slots.** Every `{ type: "encrypted_content", encrypted_content: string }` part whose payload is **not** backend ciphertext becomes `{ type: "input_text", text: payload }` and loses `encrypted_content`. Walk `agent_message.content` and `function_call_output.output` when that output is an array. Leave ciphertext parts untouched.
2. If step 1 changed nothing, **opaque blobs.** Delete `encrypted_content` on `type: "reasoning"` and `type: "compaction"` / `compaction_summary` / `context_compaction` items. Keep the item and any `summary`.
3. If neither step changes the body, do not retry.

Backend ciphertext, copied from opencodex's cheap gate: string length `>= 64` and `/^[A-Za-z0-9+/=_-]+$/`. Do not add a Fernet decoder.

One retry maximum per candidate attempt. If the replay still errors, return that response to the client.

### Attempt accounting

The retry is the same candidate attempt. Do not open a second attempt span. Do not write cooldown. Do not fall through to the next candidate unless the **replay** status is already a `shouldFallbackStatus` value.

`usageCapture` and `session.finishFrom` observe only the response that is returned to the client.

## Scope

- Core: classify ciphertext vs plaintext and produce the retry body.
- Server: raw SSE preflight, HTTP 400 intercept, same-candidate replay inside `completeRawAttempt` before usage capture.
- Tests for rewrite, preflight classification, and the raw pipeline retry.
- User-facing changeset on `aio-proxy`, `@aio-proxy/core`, and `@aio-proxy/server`.

## Non-goals

- Preemptive rewrite on the first send.
- Retry after any generated content, or after `response.output_item.added`.
- Retry of SSE errors other than `invalid_encrypted_content`.
- Next-candidate fallback for this error.
- Changing the cross-protocol transform that already drops `encrypted_content`.
- Compact endpoint, other inbound protocols, or a second retry when plaintext and blobs are both present.
- New dashboard events or trace attributes.

## Verification

- Spawn plaintext `encrypted_content` + 200 SSE `invalid_encrypted_content` after `response.created` must invoke raw twice, return only the second stream, and never expose the error frame.
- The same error after an `output_text.delta` must not retry.
- Ciphertext-shaped `encrypted_content` parts must not be converted to `input_text`.
- Reasoning-only blobs retry by deleting `encrypted_content`, not by converting them to text.
- Ordinary raw `400` that is not this code, and raw `422`/`429`/`5xx` fallback, stay unchanged.
