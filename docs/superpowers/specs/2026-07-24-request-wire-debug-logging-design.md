# Request Wire Debug Logging and Full Payload Tap Design

Date: 2026-07-24
Status: Existing foundation implemented; full-payload revision approved

## Background

Request `3f7b45b5-80c0-40b1-937b-55f6d06ff3c9` exposed two observability gaps:

1. provider-attempt failures did not retain useful transport error codes;
2. the process log could not compare an inbound model request with the final HTTP request sent by a provider transport.

The request-scoped logging context, observed fetch boundary, transport error details, and OpenAI ChatGPT OAuth `Host` fix have already been implemented. The first debug snapshot implementation deliberately replaced model payloads with hashes and descriptors and bounded diagnostic body reads.

That payload policy no longer matches the product goal. aio-proxy is a local proxy whose logs should let users inspect their own model inputs and outputs. Model traffic therefore needs complete, replayable text rather than redacted summaries. Unbounded bodies must be logged incrementally so observability does not require accumulating a full request or response in memory.

## Goals

- At debug level, record the complete application-level text body for:
  - the inbound model request;
  - every final HTTP request sent to an upstream provider;
  - every upstream HTTP response, including successful streams.
- Preserve model payload values exactly as decoded text. Do not redact fields, replace strings with descriptors, hash values, or impose a logging-specific body limit.
- Keep complete URL query parameters and header values, except for the two explicit credential headers `authorization` and `x-api-key`.
- Correlate every body part with the existing request ID and, for upstream traffic, attempt index, Provider ID, and model ID.
- Keep memory bounded by the current decoded chunk or SSE event instead of the total body size.
- Ensure debug observation does not alter body bytes, stream order, backpressure, cancellation, fallback, or provider behavior.
- Preserve OAuth control-plane token and secret redaction.

## Non-goals

- Do not remove the protocol parser's existing encoded and decoded request-size limits. Those are request validation rules, not log truncation.
- Do not expose `authorization` or `x-api-key` values.
- Do not remove redaction from OAuth login, token exchange, or token refresh diagnostics.
- Do not capture dashboard, catalog refresh, quota polling, or unrelated background HTTP traffic.
- Do not add remote shipping, sampling, sidecar payload files, Provider ID filters, or new logging configuration.
- Do not aggregate a complete JSON body or complete stream into one log record.
- Do not promise byte-for-byte reconstruction for invalid non-UTF-8 bodies. Supported model protocols use UTF-8 JSON or SSE; embedded binary model data remains complete inside that text representation.

## Selected approach

Extend the existing request-scoped observed transport with backpressure-aware body taps. Metadata remains in the existing snapshot/result events. Body content is emitted as ordered part events followed by one terminal event.

Rejected alternatives:

1. A complete body in one log record requires memory proportional to the body and cannot support unbounded streams.
2. Draining `Request.clone()` or `Response.clone()` independently can make `ReadableStream.tee()` buffer the slower branch without a limit.
3. Sidecar payload files keep the main JSONL small but make model inputs and outputs harder to inspect and correlate.
4. LogTape sinks solve structured JSONL and file rotation, but they do not capture HTTP bodies or define SSE aggregation. The application must perform the tap before emitting LogTape events.

## Existing request context

`RequestRecorder.begin()` remains the source of the internal request ID. The shared protocol pipeline runs inside one request `AsyncLocalStorage` scope. Each provider candidate nests an attempt scope containing its zero-based attempt index, Provider ID, and resolved model ID.

The server and plugin logging bridges merge that active context at emission time. Logs outside a model request remain unchanged. Concurrent requests must remain isolated.

No new context or logging abstraction is needed.

## Metadata events

The existing events remain the start records for each observed message:

- `request.inbound_snapshot` contains inbound protocol, method, URL, and headers;
- `request.upstream_snapshot` contains attempt identity, method, URL, and headers;
- `request.upstream_result` contains attempt identity, duration, outcome, status, response headers, or transport exception.

Snapshot/result events no longer contain a sanitized or aggregated body. Their request/attempt identity is the join key for body events.

### URL policy

- Preserve scheme, host, port, pathname, and every query parameter value.
- Continue removing URL user info because it is a credential location, not a model parameter.

### Header policy

- Replace the values of `authorization` and `x-api-key`, case-insensitively, with `[REDACTED]`.
- Preserve every other header value without the current allowlist or 512-character truncation.

## Body events

Every observed body emits zero or more chunk records:

```ts
{
  event: "request.body_chunk",
  requestId,
  direction: "inbound" | "upstream_request" | "upstream_response",
  attemptIndex?,
  providerId?,
  modelId?,
  sequence,
  text
}
```

`sequence` starts at zero for each body and increases by one. Upstream attempt identity is included directly rather than inferred from ambient context after the stream escapes its initiating callback.

Every observed body that begins consumption then emits exactly one terminal record:

```ts
{
  event: "request.body_terminal",
  requestId,
  direction,
  attemptIndex?,
  providerId?,
  modelId?,
  sequence,
  byteLength,
  outcome: "complete" | "cancelled" | "error",
  errorType?
}
```

The terminal `sequence` is the next sequence after the last chunk. `byteLength` is the number of source bytes observed before termination. Error messages are excluded because SDK errors may embed secrets or payloads.

An empty consumed body emits only its terminal record. A cancelled or failed body keeps every part observed before termination and is never labeled complete. A `null` body or a response body that is never consumed emits no body event because no stream outcome has occurred.

## Framing and reconstruction

For JSON and other UTF-8 text bodies, use one streaming `TextDecoder`. Each non-empty decoded segment becomes one `request.body_chunk`. Concatenating `text` by `sequence` reconstructs the complete decoded body, including whitespace and JSON field order.

For `text/event-stream`, retain decoded text until a complete SSE event boundary is available. Emit the complete original SSE frame, including its field lines and delimiter, as one chunk. A final unterminated frame is emitted when the source closes. Only the current event may be buffered; there is no event-size limit.

The tap observes application-level bytes exposed by the Fetch API. It does not attempt to reconstruct network transfer encoding, HTTP/2 frames, or bytes already decompressed by the runtime.

## Data flow

### Inbound request

When debug logging is enabled, the pipeline creates an observed inbound `Request` before protocol parsing and uses that request for all later parsing and clones. The observed body stream emits chunks only as the protocol parser consumes the request. The metadata event is emitted immediately.

At info or higher, the original `Request` is used directly with no wrapper or decoder.

### Upstream request

The observed fetch boundary builds the final application-level `Request` after provider URL, header, credential, and body rewriting. In debug mode it replaces only the body stream with a tap and passes the resulting request to the existing proxy-aware fetch. The tap emits as fetch consumes the body.

The fetch input's `decompress` option and all existing request metadata must be preserved.

### Upstream response

In debug mode, the observed fetch boundary returns a response whose body is a tapped view of the original stream. The wrapper preserves status, status text, headers, URL/redirect metadata used by consumers, and cancellation semantics. Chunks are emitted only when downstream code consumes the response, so the logger does not drain ahead of the client or fallback pipeline.

If the response body is never consumed, no body or terminal events are invented. Once consumption starts, completion, cancellation, or failure emits the matching terminal outcome.

At info or higher, the original `Response` is returned unchanged.

## Failure and security behavior

- A tap must enqueue the original source chunk unchanged before or independently of diagnostic decoding.
- Logging, decoding, or framing failures must not error or cancel the application stream. They stop diagnostic emission for that body and attempt one `error` terminal record.
- Source stream failures and cancellations retain their real behavior after the terminal record is attempted.
- Model-body keys named `token`, `secret`, `password`, `cookie`, or similar are not special and are recorded unchanged. Only the explicit HTTP credential headers are redacted in model traffic.
- OAuth control-plane requests stay outside the model request tap and retain their existing secret redaction.

## Performance

- Non-debug levels add no clone, stream wrapper, decoding, or body log event.
- Debug mode performs one streaming UTF-8 decode and one structured log emission per decoded chunk or SSE event.
- Memory is proportional to the current source chunk plus the current incomplete UTF-8 sequence or SSE event, not total body length.
- Log volume is intentionally unbounded while debug capture is enabled. Existing file/rotating-file sink configuration remains responsible for storage retention.

## Tests

- Inbound, upstream-request, and upstream-response text can each be reconstructed by sorting chunks on their identity and sequence.
- Large JSON bodies produce multiple chunks without hashes, descriptors, redaction, or a logging-specific oversized result.
- Multibyte UTF-8 split across source chunks reconstructs correctly.
- SSE frames split across arbitrary source chunks emit one record per complete event and preserve a final unterminated frame.
- Empty consumed, completed, cancelled, and failed bodies emit exactly one correct terminal record; null and never-consumed bodies emit none.
- The application receives unchanged request/response bytes and unchanged errors while logging succeeds, throws, or encounters invalid text.
- Debug response tapping preserves observable response metadata needed by current consumers.
- URL query values and ordinary headers remain complete; `authorization` and `x-api-key` alone are redacted case-insensitively.
- OAuth control-plane token/secret tests remain redacted.
- Info and higher levels return the original request/response path without tap work.
- Concurrent request and fallback attempts never mix body identity or sequence.
- Existing OpenAI ChatGPT OAuth `Host` regression coverage continues to pass.
- `bun run preflight` passes.

## Success criteria

1. A user can reconstruct and compare the complete decoded inbound request, final upstream request, and consumed upstream response from JSONL logs.
2. No model payload value is sanitized, hashed, summarized, or truncated by logging.
3. Only `authorization` and `x-api-key` header values are redacted in model traffic; OAuth control-plane secrets remain protected.
4. Debug logging does not accumulate an entire body and does not change routing, fallback, status mapping, cancellation, usage capture, or client-visible bytes.
5. At info or higher, payload capture adds no body-processing work.
