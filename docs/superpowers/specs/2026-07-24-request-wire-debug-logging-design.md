# Request Wire Debug Logging Design

Date: 2026-07-24
Status: Design approved; written-spec review pending

## Background

Request `3f7b45b5-80c0-40b1-937b-55f6d06ff3c9` exposed two observability gaps:

1. `request.provider_attempt_failed` recorded only `errorType: "Error"`, so the useful Bun error code `ConnectionRefused` was lost.
2. The process log could not compare the inbound request with the final HTTP request sent by a provider transport.

The concrete failure was caused by the OpenAI ChatGPT OAuth raw transport copying the inbound `Host` header to a different origin. A minimal request without `Host` reached ChatGPT successfully; adding only a loopback `Host` reproduced the same local `Error` and `ConnectionRefused` result. The current log mapped that local exception to a synthetic 500 even though no upstream HTTP response existed.

The existing logger already supports `server.logging.level: "debug"`, but the request pipeline emits no debug payload events.

## Goals

- Give every log emitted inside a proxy request's asynchronous chain the same internal request ID.
- Correlate each provider attempt with its request ID, attempt index, Provider ID, and model.
- At debug level, record a safe snapshot of:
  - the inbound HTTP request;
  - the final HTTP request sent to an upstream provider;
  - the upstream HTTP response metadata or transport exception.
- Capture the final application-level `Request` passed to fetch by API providers, AI SDK providers, and built-in OAuth providers rather than only the intermediate model invocation. Network-added headers remain outside the observable boundary.
- Preserve enough structure, byte counts, and hashes to compare inbound and upstream requests without writing credentials or user payloads in clear text.
- Expose safe exception codes such as `ConnectionRefused` on the existing provider-attempt warning.
- Fix the OpenAI ChatGPT OAuth `Host` forwarding regression.

## Non-goals

- Do not emit clear-text credentials, cookies, user prompts, tool outputs, images, files, or encrypted reasoning state.
- Do not add a switch that disables redaction.
- Do not buffer or log successful streaming response bodies.
- Do not assign fake request IDs to startup, config reload, catalog refresh, quota polling, or other background work.
- Do not guarantee final-wire observation for third-party OAuth plugins that ignore the host-provided fetch function.
- Do not persist payload snapshots in SQLite or expose them in the Dashboard.
- Do not add remote log shipping, sampling, or Provider ID filters in this change.

## Selected approach

Use a request-scoped `AsyncLocalStorage` context and a host-provided observed fetch boundary.

Rejected alternatives:

1. Pipeline-only snapshots cannot see headers and bodies generated later by an AI SDK or OAuth plugin.
2. Monkey-patching `globalThis.fetch` would capture unrelated login, catalog, quota, and dashboard traffic and would make concurrent attribution fragile.

## Request log context

The server owns one `AsyncLocalStorage<RequestLogContext>` instance:

```ts
type RequestLogContext = {
  readonly requestId: string;
  readonly attemptIndex?: number;
  readonly providerId?: string;
  readonly modelId?: string;
};
```

`RequestRecorder.begin()` remains the source of the internal request ID. Immediately after beginning a proxy request, the shared protocol pipeline runs the remaining asynchronous work inside that request context. Token-count routes do the same.

Each candidate iteration nests an attempt context containing its zero-based attempt index, Provider ID, and resolved model ID. Promise continuations and `ReadableStream` callbacks created within the scope retain the context under the supported Bun runtime.

The server and plugin logging bridges merge the active context at emission time. Ambient `requestId`, `attemptIndex`, `providerId`, and `modelId` values take precedence over same-named plugin bindings so a plugin cannot break correlation. Logs outside a proxy request context remain unchanged and do not receive a request ID.

Concurrent requests must remain isolated; an event may never inherit another request's context.

## Observed HTTP transport

The host provides a fetch wrapper that observes the final application-level `Request` immediately before delegating to the real fetch implementation.

- API and AI SDK providers receive the observed wrapper around their existing proxy-aware fetch.
- OAuth `RuntimeContext` gains an optional host fetch function. All built-in OAuth runtimes use it as the final network boundary, falling back to `globalThis.fetch` only when an older host does not provide it.
- Provider-specific URL/header rewriting and credential injection happen before observation. The observer delegates unchanged to the existing proxy-aware fetch; lower-level proxy routing and network-added headers remain outside the observable boundary.
- Third-party OAuth plugins remain runtime-compatible. They receive the additive context field but must adopt it to expose final-wire debug snapshots.

The wrapper reads the active request/attempt context. Without an active context, or when the configured level is not debug, it delegates without cloning or reading the body.

## Debug events

All events below are mapped explicitly to `debug` in the existing exhaustive server-log level table.

### Inbound request snapshot

Emitted once per proxy request after the request session has started:

```ts
{
  event: "request.inbound_snapshot",
  requestId,
  inboundProtocol,
  method,
  url,
  headers,
  body
}
```

### Upstream request snapshot

Emitted for each actual provider HTTP call:

```ts
{
  event: "request.upstream_snapshot",
  requestId,
  attemptIndex,
  providerId,
  modelId,
  method,
  url,
  headers,
  body
}
```

### Upstream result

Every observed fetch emits exactly one result event:

```ts
{
  event: "request.upstream_result",
  requestId,
  attemptIndex,
  providerId,
  modelId,
  durationMs,
  outcome: "response" | "exception",
  statusCode?,
  headers?,
  body?,
  error?
}
```

Response bodies are snapshotted only for non-2xx responses. Successful response bodies, including SSE streams, are never cloned or buffered. Failure to read a debug clone must not affect the response returned to the pipeline.

## Snapshot and redaction rules

Snapshots are diagnostic representations, not replayable requests.

### URL

- Keep scheme, host, port, and pathname.
- Keep query parameter names but replace every query value with `[REDACTED]`.
- Never log URL user info.

### Headers

- Keep header names so routing mistakes such as forwarding `Host` remain visible.
- Replace values for `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, API-key variants, and names containing token, secret, or credential markers with `[REDACTED]`.
- Keep bounded values only for the explicit transport allowlist: `host`, `content-type`, `content-length`, `accept`, `accept-encoding`, and `user-agent`.
- Replace every other header value with `[REDACTED]`. Header names remain visible so unknown forwarded headers can still be compared without trusting their contents.

### Body

Every fully captured request body snapshot includes its total byte length and SHA-256 digest of the original bytes. A credential field has no standalone digest; the whole-body digest remains available only for comparing the inbound and upstream byte sequences.

For JSON bodies no larger than 1 MiB, include a recursively sanitized JSON structure:

- keep object keys, array order, booleans, numbers, nulls, and string values only for the exact protocol-control field names `model`, `stream`, `role`, `type`, and `effort`;
- replace credential fields without a digest;
- replace free-form text, instructions, prompts, tool arguments/results, image/file data, data URLs, base64 blobs, and `encrypted_content` with a descriptor containing byte length and SHA-256;
- summarize every other string value.

For larger, non-JSON, multipart, or unreadable request bodies, log only media type, total byte length, SHA-256, and an omission reason. Never emit a raw preview. Request-body reads remain bounded by the proxy's existing request limits.

Observed non-2xx response clones are read to at most 1 MiB. If that limit is exceeded, cancel the clone and log the media type, the captured lower bound, and an `oversized` omission reason without an exact length or digest.

Snapshot failures produce a safe metadata-only event and never fall back to logging the original value.

## Exception diagnostics

`request.provider_attempt_failed` keeps its current warn-level identity and status fields. For exceptions it additionally records data-only, bounded properties when present:

- `exceptionCode`;
- `causeType` and `causeCode`;
- `errno` and `syscall`.

Property access must use own data descriptors and must not invoke arbitrary getters. Exception messages remain excluded because provider and SDK errors may embed credentials, prompts, or upstream response bodies.

This is sufficient for the diagnosed case to report `exceptionCode: "ConnectionRefused"` instead of only `errorType: "Error"`.

## OpenAI ChatGPT OAuth fix

The dynamic fetch must delete the inbound `Host` header before changing the destination URL and invoking fetch. It continues replacing caller authorization with the OAuth credential.

The regression test must invoke the raw OpenAI Responses capability with a POST request carrying a loopback `Host`, then assert that:

- the captured upstream request targets `chatgpt.com`;
- the loopback `Host` was not forwarded;
- the request body and non-sensitive caller headers are preserved;
- OAuth identity headers are still injected.

No broader header abstraction is required for this fix; existing provider-specific credential sanitation remains in place.

## Performance and failure behavior

- Non-debug levels perform no request/response body clone, hash, parse, or serialization.
- Debug mode may add latency and body reads by design, but all snapshot work is bounded and isolated from the provider result.
- Logging and snapshot exceptions are swallowed after emitting the smallest safe fallback event.
- Debug logging must not change fallback decisions, status mapping, cancellation, stream ownership, usage capture, or SQLite request attempts.

## Tests

- Async context survives promises and `ReadableStream` callbacks and remains isolated across concurrent requests.
- Server and plugin logs inside a request automatically contain the correct request ID; background logs do not.
- Candidate logs contain the correct attempt index and Provider ID during fallback.
- Non-debug transport delegates without cloning or reading bodies.
- API, AI SDK, and each built-in OAuth runtime use the observed final fetch boundary.
- Header, URL, JSON, text, secret, image/base64, encrypted-content, and oversized-body redaction cannot expose sentinel values.
- Non-2xx response snapshots do not consume the returned response body; successful streams are not cloned.
- Exception code extraction records `ConnectionRefused` without reading getters or logging messages.
- The ChatGPT raw POST `Host` regression is covered.
- `bun run preflight` passes.

## Success criteria

1. Given one proxy request with fallback, all request-scoped server/plugin/debug events share one request ID and have distinct attempt indexes.
2. At debug level, operators can compare inbound and final upstream URL, header names/allowed values, sanitized body structure, byte length, and SHA-256.
3. At info or higher, payload capture adds no body-processing work.
4. Credentials and user payload sentinels never appear in serialized logs.
5. The diagnosed ChatGPT OAuth request no longer forwards the loopback `Host` and reaches the intended upstream.
6. Provider routing, response streaming, request recording, and usage accounting remain unchanged.
