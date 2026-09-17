# Raw OpenAI Responses Orphan Tool Output

## Goal

Same-protocol raw passthrough must not forward a Responses `input` item that no upstream can pair: a `function_call_output` / `custom_tool_call_output` with no `call_id`, or a `call_id` whose matching call is missing. Rewrite it to a user note on the first attempt.

## Background

Local production, 2026-09-17. Codex thread `01a0ad3f-586d-7a61-b50d-b1a8904d9f0a` failed every retry with:

```text
unexpected status 422 Unprocessable Entity: Unprocessable Entity, url: http://localhost:9317/v1/responses
```

Trace `d1243ed1-9e55-4a98-aa95-fed4394c3f54` (and the earlier burst starting `82bc85f1-5544-4689-af70-028f227f4df0`):

1. Codex Desktop `POST /v1/responses` for `grok-4.6`, stream, inbound `openai-response`.
2. Session affinity selected `carpool`. Protocol match, raw passthrough.
3. Upstream NewAPI (`x-new-api-version: v1.0.0-rc.29`) returned HTTP 422 SSE:

```json
{"error":{"message":"Unprocessable Entity","type":"invalid_request_error","param":"","code":null}}
```

4. `fallback: false`. Nearby `grok-4.6` sessions on `carpool` stayed 200.

The last 200 for that thread (`3f488538-678b-469b-98c4-c4d65aa9e1c6`) and the first 422 differ by three trailing items. The fatal one is a synthetic Codex Desktop delegation:

```json
{
  "type": "function_call_output",
  "id": "fco_01a0ad8a-1779-7b22-b029-a81a7bb703ba",
  "name": "send_message_to_thread",
  "namespace": "codex_app",
  "output": "<codex_delegation>…</codex_delegation>"
}
```

No `call_id`, no matching `function_call`. Ingress already accepts that shape so parse does not 400. Convert rejects missing `call_id` as `function_call_output.call_id` so a later raw candidate can run. Raw currently forwards the bytes. Official OpenAI answers `400 No tool call found for function call output with call_id …`. NewAPI answers an empty 422. `isToolPairingRejection` matches only the official prose, so the existing raw retry never fires.

`repairOpenAIResponsesToolPairing` already turns an output without `call_id` into:

```json
{ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "[orphan tool result] …" }] }
```

It only runs today after a classified pairing rejection.

## Behavior

`rewriteOpenAIResponsesRequest` (create only) applies `repairOpenAIResponsesToolPairing` to `body.input` when that field is an array, **before** the first upstream call.

| Input | Raw outbound |
|---|---|
| Paired `function_call` + `function_call_output` | Unchanged. Keep verbatim bytes when model / background / effort are also unchanged. |
| Output with `call_id` but no preceding call | User note via existing `orphanOutputNote`. |
| Output with no `call_id` (Codex `send_message_to_thread`) | Same note, label `[orphan tool result]`. |
| Unanswered call | Existing unanswered-call assistant note. |
| Compact endpoint | Unchanged. Do not repair. |
| Convert / model path | Unchanged. Still reject missing `call_id` as unsupported so a later raw candidate can run. |

Do **not** classify generic `Unprocessable Entity` / empty-`code` 422 as a pairing retry. That would rewrite bodies NewAPI rejected for any reason.

## Scope

- Call the existing repair from `rewriteOpenAIResponsesRequest`.
- Cover the create raw path with adapter tests.
- Update comments that currently say raw forwards a missing-`call_id` output verbatim.
- User-facing changeset on `aio-proxy` and `@aio-proxy/core`.

## Non-goals

- Saving the already-poisoned Codex thread. New turns after the fix work; that history still carries the dirty item until the client drops it or a new thread is started.
- Classifying NewAPI's empty 422.
- Changing convert-path missing-`call_id` rejection.
- Compact repair, 422 fallback policy, cooldown, or affinity.
- Dropping the orphan payload. A proxy must not decide the delegation text is worthless.

## Verification

- `rawRequest` on a `send_message_to_thread` output with no `call_id` forwards a user message containing the original output text, and does not forward a `function_call_output`.
- A paired call/output with an unchanged model still forwards the original body bytes.
- Compact `rawRequest` still does not run pairing repair.
- Convert still throws `OpenAIResponsesUnsupportedFeatureError('function_call_output.call_id')` for the same item.
