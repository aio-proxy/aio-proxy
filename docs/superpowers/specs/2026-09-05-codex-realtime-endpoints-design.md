# Codex Live / Realtime endpoint support design

**Date:** 2026-09-05
**Status:** Approved direction; implementation not started

## Summary

Codex Desktop's avatar-overlay realtime voice signals against `POST /v1/live`. aio-proxy does not
register that path, so Hono's default `notFound` answers `404 Not Found` and the client reports
`Realtime voice session failed`. This design adds the Codex Live / Realtime endpoint family as
**signaling passthrough**: the proxy relays the WebRTC offer/answer exchange and the sideband
control WebSocket, while media flows client-to-upstream directly.

Realtime does not fit the generation pipeline. Its inbound shape is an SDP document plus a
long-lived WebSocket, not a JSON request with a JSON or SSE response, and it has no model-message
conversion, no egress normalization, and no token accounting. It therefore gets its own route
module and its own provider-selection path rather than a new `ProviderProtocol` value and a
`defineProtocolAdapter()` implementation whose conversion hooks would all be unreachable.

## Goals

- Serve the endpoints Codex Desktop actually calls, so realtime voice stops failing at signaling.
- Keep every call's sideband and hangup on the same upstream account that created the call.
- Answer unsupported realtime capabilities with a structured error instead of a bare 404.
- Leave the generation pipeline, the `ProviderProtocol` enum, and the API-provider config schema
  untouched.

## Non-goals

- **WebRTC media relay.** Out of scope; see Known limitations.
- Locally minted `ek_` client secrets, legacy `sessions`, transcription-only sessions,
  translations, and SIP dialog control. Registered as explicitly unsupported.
- Usage capture and pricing for realtime traffic.
- Folding realtime into the router in this phase; the upgrade path is specified but not built.

## Known limitations

**Media plane.** With no media relay, WebRTC media is negotiated client-to-upstream. If the client
can reach aio-proxy but not the upstream media plane, `POST /v1/live` returns 200 and the call
fails immediately afterwards. This is exactly what the reference implementation's optional relay
exists to solve. Accepted for this phase; the spec does not claim otherwise.

**Restart.** Losing the in-process call store does not by itself terminate an established
client-to-upstream media session. What is lost is the proxy's ability to route a later sideband
attachment or hangup for that call, and any sideband socket the proxy was relaying closes with the
process. Media may continue with no control channel.

**Private contract.** The `/live` endpoint and the `intent=quicksilver&architecture=avas` signaling
form are derived from the reference implementation and an observed client, not from published
documentation. Treat the wire details as reference-derived until exercised against a real Codex
Desktop client.

## Endpoint table

### Proxied

| Method | Path | Upstream | Notes |
| --- | --- | --- | --- |
| POST | `/v1/live` | `chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas` | `Location` rewritten to `/v1/live/<callId>` |
| POST | `/v1/realtime` | same | `Location` rewritten to `/v1/realtime/calls/<callId>` |
| POST | `/v1/realtime/calls` | same | `Location` rewritten to `/v1/realtime/calls/<callId>` |
| GET | `/v1/live/:call_id` | `wss://api.openai.com/v1/live/<callId>` | sideband relay |
| GET | `/v1/realtime/calls/:call_id` | `wss://api.openai.com/v1/realtime/calls/<callId>` | sideband relay |
| GET | `/v1/realtime` | with `call_id`: `wss://api.openai.com/v1/realtime?intent=quicksilver&call_id=<id>`; without: `wss://api.openai.com/v1/realtime?model=<requested>` | sideband or direct |
| POST | `/v1/realtime/calls/:call_id/hangup` | `api.openai.com/v1/realtime/calls/<callId>/hangup` | uses the call's pinned account |

`POST /v1/realtime` deliberately advertises `/v1/realtime/calls/<callId>`, not `/v1/realtime/<callId>`:
no GET route exists at the latter.

### Registered as unsupported

`POST /v1/realtime/client_secrets`, `POST /v1/realtime/sessions`,
`POST /v1/realtime/transcription_sessions`, `GET|POST /v1/realtime/translations`,
`POST /v1/realtime/translations/client_secrets`,
`POST /v1/realtime/calls/:call_id/{accept,reject,refer}`.

Each answers `501` with `type: "not_supported_error"`, `code: "realtime_capability_not_supported"`.
The ChatGPT/Codex OAuth upstream has no equivalent capability. Registering them converts a
confusing 404 into a diagnosable answer.

## Architecture exception

`CLAUDE.md` states that `packages/server/src/routes/pipeline.ts` is the only candidate loop.
Realtime signaling contains a second candidate loop, so that rule is amended to scope it to
**generation** candidate loops, matching the wording already used in the cross-protocol routing
section. The realtime loop is a narrow exception justified by three properties: no model-message
conversion, no usage capture, and a non-request/response transport. Every other pipeline
responsibility the rule protects — provider-kind branching, stream preflight, request recording —
stays out of the realtime routes.

## Components

New `packages/server/src/routes/realtime/`:

- `index.ts` — exports only
- `realtime.ts` — route registration, including the unsupported set as a small table-driven loop
- `signaling.ts` — create flow: body buffering, model handling, candidate attempts, response validation
- `sideband.ts` — upstream dial, downstream upgrade, bidirectional relay
- `hangup.ts` — pinned-account control request
- `call-store.ts` — call records, reserve/release, expiry, capacity
- `provider-select.ts` — realtime candidate selection

Tests are colocated. Files are split further only when a responsibility earns one.

Changes to existing files: `packages/plugin-sdk/src/runtime.ts` (the capability type),
`packages/server/src/plugin-runtime/capabilities.ts` (materialize `realtime`),
`packages/server/src/server/api-key-auth/api-key-auth.ts` and `agent-auth/agent-auth.ts` (set the
caller principal on the context), `packages/server/src/server-log.ts` (four log types),
`packages/server/src/server/server.ts` (mount the routes, re-export `websocket`),
`packages/cli/src/run/run.ts` (pass `websocket` to `Bun.serve`), and
`packages/plugins/openai-chatgpt/src/runtime/runtime.ts` (the realtime transport and the
`rewriteCodexUrl` corrections).

### Plugin capability

`packages/plugin-sdk/src/runtime.ts` gains an optional capability on `OAuthRuntimeResult`:

```ts
export type RealtimeDialInput = {
  readonly style: 'live' | 'realtime-calls' | 'realtime-query' | 'realtime-direct';
  readonly callId?: string;
  readonly model?: string;
  /** Inbound headers the plugin may forward selectively. Caller credentials are
   *  already stripped by the auth middleware; the plugin adds its own upstream
   *  auth and never forwards an inbound `authorization`. */
  readonly headers: Headers;
  readonly signal: AbortSignal;
};

export type RealtimeTransport = {
  readonly models: readonly string[];
  readonly fetch: (request: Request) => Promise<Response>;
  /** Resolves only once the socket is OPEN. Rejects on handshake failure,
   *  exposing the upstream status and body when there is one. Aborting
   *  `signal` abandons a pending dial and closes any socket that opens. */
  readonly dial: (input: RealtimeDialInput) => Promise<WebSocket>;
};
```

`RuntimeProviderInstance` gains `readonly realtime?: RealtimeTransport`. This is purely additive:
the existing "at least one of raw/model/image/embedding" union is unaffected because the ChatGPT
provider already carries `raw` and `model`.

**The type change alone is not enough.** `createRuntimeProvider` in
`packages/server/src/plugin-runtime/capabilities.ts` builds its return value field by field — it
copies `raw`, `providerTools`, `tokenCount`, and the catalog-derived transports, and every other
field of `result` is discarded. Without an explicit copy step, `provider.realtime` is `undefined`
for every provider and the selector always finds zero candidates. `createRuntimeProvider` must
validate `result.realtime` (an object with a `models` array and function `fetch`/`dial`, rejected
like `PluginRawResolverError` otherwise) and attach it to `base`, so it reaches all four return
branches.

`realtime.fetch` and `dial` are a **separate transport from the plugin's `dynamicFetch`**. That
fetch wraps `createOpenAIStreamFetch('openai-response', …)`, which applies Responses-protocol
stream handling and would mangle an SDP body and a hangup control response. The realtime transport
shares only credential injection: `authorization`, `ChatGPT-Account-Id`, `Originator`,
`User-Agent`, and a fresh `session-id`.

URL knowledge stays in the plugin, consistent with the existing `rewriteCodexUrl` invariant that
every accepted inbound path maps to an explicit upstream endpoint. The server passes a `style`, not
a URL.

Two corrections to the current `rewriteCodexUrl` are required:

1. It assigns `endpoint.search = target.search`. A signaling endpoint constant carries
   `?intent=quicksilver&architecture=avas`, and an inbound `POST /v1/live` has no query, so the
   current assignment **erases the required upstream parameters**. Endpoint-owned query parameters
   must survive; inbound parameters merge on top without dropping them.
2. All three create aliases plus hangup need explicit mappings, and hangup targets
   `api.openai.com`, not the Codex base. For realtime the mapping **fails closed**: an unmapped
   realtime path is a server error, never a passthrough of the proxy's own inbound URL.

The realtime mappings match on the **exact pathname**, not `endsWith` as the existing Codex
endpoints do, with `:call_id` as the only variable segment. `endsWith` was acceptable for a handful
of distinctive suffixes; `/v1/realtime` and `/v1/realtime/calls` are prefixes of other realtime paths
and would collide. Sideband GETs never go through this rewrite at all — they are `dial(style)`, and
`dial` owns the `wss://` URL; only `fetch` paths (the three create aliases and hangup) are rewritten.

### Outbound proxy

Provider and global proxy configuration is applied today by wrapping *fetch* with Bun's `proxy`
option (`createProxyFetch`). A plugin-constructed `new WebSocket(...)` inherits nothing from that
wrapper, so sideband would connect directly while signaling went through the configured proxy.

`bun-types@1.3.14` declares `WebSocketOptions` as the intersection of `WebSocketOptionsProtocolsOrProtocol`,
`WebSocketOptionsTLS`, `WebSocketOptionsHeaders`, `WebSocketOptionsProxy`, and
`WebSocketOptionsCompression`, so `new WebSocket(url, { proxy })` is supported — `proxy` accepts a
URL string or `{ url, headers }`. The plugin runtime therefore receives the effective proxy at
construction — the same value `createProxyFetch` is given, resolved by `materialize.ts` as
`options.effectiveProxy ?? (config.proxy === false ? null : config.proxy ?? null)` — and `dial`
passes it to the constructor. Threading it through `RealtimeDialInput` instead would put host
transport configuration in a per-request field; the proxy is provider configuration, so it belongs
on the runtime.

Because a silently ignored `proxy` would reintroduce exactly the leak this section exists to
prevent, one integration test dials through a local proxy and asserts the proxy saw the CONNECT. If
a future Bun drops the option, that test fails loudly instead of the traffic quietly going direct.

## Provider selection

Eligibility: the provider is enabled, exposes `realtime`, its realtime `models` include the
normalized model, its effective weight is non-zero, and neither the requested nor the normalized
model is excluded by router model policy. Both ids are checked because they differ: excluding
`gpt-realtime` must take effect even though selection matches on `gpt-live-1-codex`. Effective
weight uses the same rule as the router — authored weight defaults to `1`, a model override
replaces it, the result is `Math.round`ed and clamped to `0..10000`, and `<= 0` is skipped.
Ordering is deterministic: priority descending, then weight descending, then provider ID. Weighted
random draw is deliberately absent in this phase; **zero-weight and exclusion filtering are not**,
because those are eligibility rules rather than distribution rules.

Model normalization mirrors the reference's `codexRealtimeModel`: empty, `gpt-realtime`,
`gpt-realtime-*`, or anything containing `realtime-preview` maps to `gpt-live-1-codex`; any other
value passes through.

Normalization applies **to selection only**. On the wire:

- Signaling rewrites the upstream model field, including `session.model` for the JSON form, while
  preserving the SDP and all other session settings.
- Direct WebSocket sends the **originally requested** model upstream, defaulting to `gpt-realtime`
  when absent. Substituting `gpt-live-1-codex` there would diverge from the reference.

### Upgrade path into the router

Deleting `provider-select.ts` is not sufficient on its own. Folding realtime into the router
requires: a realtime entry in the capability index, a realtime arm in the capability filter,
realtime dispatch in the attempt loop, and a decision on whether realtime models appear in
`/v1/models`. The spec records this as a distinct follow-up, not a file deletion.

## Data flow

### Create

1. Authenticate. `app.use('/v1/*', modelAuthentication)` already covers these paths; no new
   middleware.
2. Buffer the body once, capped at **16 MiB**, matching the reference's `maxBodySize`. The
   server-wide `MAX_REQUEST_BODY_SIZE` is `EDITS_MULTIPART_ENCODED_LIMIT` (~851 MB), sized for
   image-edit multipart; buffering that much in memory for SDP fallback is a memory bomb. Over the
   cap is `413`. Accepted content types: `application/sdp`, `text/plain`, `application/json`,
   `multipart/form-data`; anything else is `415`.
3. Normalize the body to the upstream form, mirroring the reference's `prepareCallRequest`:
   - `multipart/form-data` → JSON `{ sdp, session? }`. The `sdp` part is required (absent is `400`);
     a `session` part must be valid JSON (`400` otherwise) and supplies the requested model.
     Content type becomes `application/json`.
   - `application/sdp` and `text/plain` → forwarded verbatim with their content type.
   - `application/json` → forwarded verbatim; the requested model is read from `model`, falling back
     to `session.model`.
   - An absent or empty model is `gpt-live-1-codex`.
4. Compute the normalized model for selection.
5. Select ordered candidates. No eligible candidate is `503` `realtime_upstream_unavailable`.
6. Attempt candidates in order. Each attempt builds a **fresh `Request`** from the buffered body — a
   fetch body is single-use and cannot be replayed. The request carries the inbound URL (the plugin
   rewrites it to the upstream endpoint), the normalized `Content-Type`, and `Accept`; it does not
   carry `Host`, `Content-Length`, `Connection`, `Accept-Encoding`, or any caller credential — the
   auth middleware has already deleted `authorization`, `x-api-key`, and `x-goog-api-key`, and the
   plugin adds its own upstream auth. Cancel every losing response body.
7. Validate the winning response before committing (below).
8. Record the call, rewrite `Location` to the inbound path's style, and return the upstream status,
   content type, and body verbatim. A JSON-wrapped SDP answer is **not** unwrapped; the client reads
   the same shape the upstream sent.

**Retry policy.** Retry a transport failure, a `5xx`, and a 2xx that fails success validation. Do
**not** retry a `4xx`: the upstream rejected this specific offer or credential, and replaying a bad
SDP onto every other provider multiplies the damage — return it as-is. `401` and `429` are the two
exceptions, since those are per-credential rather than per-offer. At most **2** attempts. Do not
retry after any bytes of a successful answer have been exposed. Stop immediately on caller abort. A
failed attempt does not prove the upstream allocated nothing, so an ambiguous failure followed by a
successful retry may leave an orphaned upstream call; this is documented, not prevented.

**Success validation.** A 2xx alone is insufficient. The response must carry a non-empty body — any
content type, since the upstream may answer raw SDP or JSON-wrapped SDP and the proxy returns either
verbatim — and a `Location` from which a call ID matching `^[A-Za-z0-9_-]{1,128}$` can be extracted.
`Location` is parsed as a URL or relative reference, including the query-parameter form, and its
**host is never used as a future connection target** — sideband and hangup targets come from the
plugin. A 204, an empty body, or a missing or unparseable `Location` is a failed attempt.

### Call store

Record: call ID, `providerId`, `accountId`, `runtimeRevision`, normalized model, requested model,
inbound style, caller owner, creation time, and current attachment.

Pinning `providerId` alone is insufficient: a re-login rebuilds the runtime under the same Provider
ID, so a call created under account A could later attach under account B. The record therefore also
pins `accountId` and `runtimeRevision` — the field `materialize.ts` already feeds into
`runtimeIdentity` and which every credential write bumps, so a re-login moves it. A pin is valid
when all three still match the live runtime. Token refresh alone does not change `runtimeRevision`
and stays valid; re-login, removal, disabling, and config reload invalidate the pin, and the call
answers `503`.

**Caller ownership.** `/v1/*` authentication establishes that a caller may use the proxy, not that
it owns a given call. Sideband and hangup verify the caller matches the creator; a mismatch is
`403`. Without this, any authenticated caller holding a call ID could attach or hang up.

The owner must be recorded at create time, because `stripCallerCredentials` deletes `authorization`,
`x-api-key`, and `x-goog-api-key` from the request before the route runs — there is nothing left to
compare later. The owner is a tagged principal:

- an agent token → `{ kind: 'agent', id: <grant id> }`, read from `context.get('agentGrant')`
- a matching configured static key → `{ kind: 'key', id: <stable digest of the matched key> }`
- no configured keys (`authenticateStaticOrAnonymous` passes everything through) →
  `{ kind: 'anonymous' }`

Two callers match when their `kind` and `id` are equal. In anonymous mode every caller is
`{ kind: 'anonymous' }`, so ownership checks pass — which is correct: with no keys configured the
proxy has no notion of distinct callers, and inventing one would reject the single legitimate client.
Capturing the principal requires the auth middleware to set it on the context alongside `agentGrant`;
it does not today.

**Reserve and release, not claim-and-hope.** Order matters:

1. Validate non-mutating conditions first — call ID shape, WebSocket upgrade intent, record
   existence, expiry, caller ownership, provider and account availability.
2. Reserve the attachment synchronously. A synchronous check-and-set in one Bun isolate needs no
   mutex; a concurrent second attachment gets `409`.
3. Release on **every** failing path after reservation: upstream dial failure, downstream upgrade
   failure, and downstream disconnect during dial.

Reservations carry an attachment token. A superseded socket's late `close` callback must not
release a newer attachment. Hangup stays available while a sideband attachment is live.

Expiry is checked on every lookup, not only swept on create — otherwise a record stays usable
indefinitely when no further creates happen. TTL is **1 hour** from creation, matching the
reference's `sessionLifetime`; a reserved attachment does not expire while it is live. Expiry
removes routing for future control requests and does not attempt to tear down media. Capacity is
capped at **1024** records; a create that would exceed it first drops expired records, and if still
full answers `503`. Cleanup also runs on hangup and on shutdown.

### Sideband

The upstream dial completes **before** the downstream upgrade is committed. This ordering is what
makes structured HTTP errors possible at all: after a 101 there is no way to answer `401`, `501`,
or `503`. Pre-upgrade failures answer as ordinary HTTP.

Pre-upgrade answers: malformed call ID `400`; missing record `404`; already attached `409`;
provider or account unavailable `503`; non-upgrade request `426` with `Upgrade: websocket`;
upstream handshake rejection surfaces the upstream status, mapping 404/501 to `501`
`not_supported_error`.

A `GET /v1/realtime` with no `call_id` is a direct connection. A **malformed** `call_id` is an
error, never a silent fall-through to direct.

**Subprotocol limitation.** Hono's Bun `upgradeWebSocket` calls `server.upgrade` without a
`headers` argument, so the proxy cannot echo a negotiated `Sec-WebSocket-Protocol` on the 101 even
though Bun's `server.upgrade` supports headers. This design is therefore limited to subprotocol-free
sideband. Implementation verifies the real client requests none; if it does, the upgrade path must
move off the Hono helper to a direct `server.upgrade` call.

**Relay.** Forward text as text and binary as binary, preserving message order and **exact byte
length**. The hazard is on the *receive* side, not only the send side: Hono's Bun adapter normalizes
every non-string frame with `message.buffer`, handing the whole backing `ArrayBuffer` to the
listener. Forwarding that value verbatim can send more bytes than the frame contained. Copy
`byteOffset .. byteOffset + byteLength` from the view before forwarding, in both directions.

Bounds: the pre-open buffer holds at most **64 frames or 1 MiB**, whichever comes first; the same cap
applies per direction to in-flight data behind a slow peer; the dial deadline is **10 s**. Overflow
closes the connection with `1011` rather than growing a queue.

Teardown is normalized and idempotent — one function, safe to call from either side's `close`, from
a dial rejection, and from shutdown. "Propagate code and reason" is not a valid blanket rule: `1005`
and `1006` are receive-only and must never be sent, reasons are capped at 123 UTF-8 bytes, and codes
outside `1000` and `3000..4999` are rejected. The mapping:

| Origin | Sent to the other side |
| --- | --- |
| clean `1000` / `1001` | same code, truncated reason |
| `1005`, `1006`, any code `< 1000` or in `1012..2999` | `1011`, no reason |
| `3000..4999` | same code, truncated reason |
| dial rejected after downstream upgrade (cannot happen by design; defensive) | `1011` |
| relay buffer overflow or internal error | `1011` |
| proxy shutdown | `1001` |

Teardown also covers an upstream that finishes connecting after the downstream has already gone
away: close it immediately and release the reservation.

### WebSocket wiring

The route module imports `upgradeWebSocket` and `websocket` from `hono/bun` directly.
`createBunWebSocket()` in this Hono version returns those same module-level bindings, so a
singleton factory adds nothing. `createServer` re-exports `websocket`, and `Bun.serve` in
`packages/cli/src/run/run.ts` passes it alongside the existing `fetch: app.fetch`.

`fetch: app.fetch` must keep receiving Bun's second argument: `upgradeWebSocket` reaches the server
through `c.env`, so a wrapper that forwards only the request would break upgrades.

**Idle timeout.** `Bun.serve`'s existing `idleTimeout: 255` governs HTTP connections and does not
carry over to an upgraded socket: the `websocket` handler has its own `idleTimeout`, defaulting to
**120 s**. A sideband channel that stays quiet longer than that is dropped with no error the client
can attribute. The exported handler therefore sets `idleTimeout` explicitly — 255, the same ceiling
as HTTP — and leaves `sendPings` at its default `true` so keepalive pings reset it.

Three adapter constraints, verified against the resolved Hono version:

- The handler dispatches `open`, `message`, and `close` only. There is **no `onError`**; failures
  surface through `close` or a rejected dial.
- Lifecycle callbacks are not awaited, so an async `onOpen` must handle its own rejection.
- `WSContext.send` discards Bun's backpressure result and exposes no `drain`, and a retained
  `WSContext` holds a `readyState` snapshot — a context captured at open is not a live liveness
  check.

## Errors

Every response uses `{"error":{"message","type","param":null,"code"}}`. One status per code:

| Status | `type` | `code` | Raised when |
| --- | --- | --- | --- |
| 400 | `invalid_request_error` | `invalid_call_id` | `call_id` fails the pattern, or a required `sdp` part is missing |
| 403 | `invalid_request_error` | `realtime_call_scope_mismatch` | caller principal differs from the creator |
| 404 | `invalid_request_error` | `realtime_call_not_found` | no record, or the record expired |
| 409 | `invalid_request_error` | `realtime_call_busy` | a sideband attachment is already reserved |
| 413 | `invalid_request_error` | `realtime_body_too_large` | create body exceeds 16 MiB |
| 415 | `invalid_request_error` | `realtime_unsupported_media_type` | create content type is not one of the four accepted |
| 426 | `invalid_request_error` | `websocket_upgrade_required` | sideband path reached without an upgrade request |
| 501 | `not_supported_error` | `realtime_capability_not_supported` | an endpoint in the unsupported set, or an upstream 404/501 on dial |
| 503 | `api_error` | `codex_auth_unavailable` | the pinned provider/account is gone, disabled, or its credential is unusable |
| 503 | `api_error` | `realtime_upstream_unavailable` | no eligible candidate, capacity exhausted, or every attempt failed |

The two `503`s are distinct by origin: `codex_auth_unavailable` means *this call's* pin no longer
resolves, `realtime_upstream_unavailable` means the proxy could not reach any upstream at all. A
non-retryable upstream `4xx` on create is returned as the upstream sent it, not remapped.

## Observability

Realtime bypasses the pipeline, so it produces no trace span. This phase emits `logServerEvent`
records for call created, call failed, sideband opened, and sideband closed. `ServerLog` in
`packages/server/src/server-log.ts` is a closed union of named log types, so these four are added to
it — otherwise the calls do not type-check. Fields are the call ID, provider ID, normalized model,
inbound style, and for closes the normalized close code. **SDP bodies, `Location` values, and
credentials are never recorded**, matching the existing allowlisted-diagnostics rule. Usage capture
is deferred; note that standard Realtime does exchange response usage, so "no token metric exists"
would be wrong as a permanent justification.

## Testing

Behavior-level, colocated with their modules.

**Production wiring.** Start the real app with its exported Bun `websocket` handler and the real
auth middleware, and complete an actual upgrade. `app.request()` cannot prove the production
upgrade path works, because it never goes through `server.upgrade`.

**Call store.** Reserve/release across each failure path: plain GET then a valid upgrade; failed
dial then a successful retry; concurrent attachments yielding `409`; a superseded socket's late
close not releasing a newer attachment; hangup during an active attachment; expiry observed on
lookup with no intervening create; a live attachment not expiring; capacity exhaustion answering
`503` after expired records are dropped.

**Relay lifecycle.** Upstream greeting arriving before the downstream is ready; downstream
disconnect mid-dial; upstream handshake rejection mapped pre-upgrade; abnormal close normalized to
`1011`; a `4000..4999` code passed through; an over-long reason truncated; slow peer and buffer
overflow; binary frames preserved at exact byte length when the source is a view into a larger
buffer; a socket quiet past 120 s staying open.

**Routing identity.** Sideband dials the creating provider even when another has higher priority;
a bumped `runtimeRevision` under the same Provider ID invalidates the pin; token refresh alone does
not; provider removal yields `503` `codex_auth_unavailable`; a different agent grant attaching or
hanging up gets `403`; anonymous mode does not `403` its only caller.

**Plugin transport.** `createRuntimeProvider` materializes `realtime` onto the runtime instance, and
a malformed `result.realtime` is rejected; each create alias reaches the exact upstream host, path,
and query, including `intent` and `architecture` surviving an inbound request with no query; hangup
targets `api.openai.com`; realtime paths match exactly rather than by suffix; signaling rewrites
`session.model` while direct preserves the requested model; an unmapped realtime path fails closed;
the realtime transport does not route through `createOpenAIStreamFetch`; the configured outbound
proxy applies to both `fetch` and `dial`, asserted by a local proxy observing the CONNECT; caller
credentials never reach upstream.

**Signaling and state.** Multipart normalized to `{ sdp, session }` with the model taken from
`session`; multipart missing `sdp` is `400`; an unaccepted content type is `415`; a body over 16 MiB
is `413`; missing or unparseable `Location`; 2xx with an empty body; a JSON-wrapped SDP answer
returned verbatim; an upstream `400` returned without retrying the next provider; a `5xx` retried;
attempts capped at 2; body replayed correctly on fallback to a second provider; caller abort stops
the loop; `Location` rewritten per inbound style; selector skips disabled, non-realtime,
zero-weight, and excluded candidates, with exclusion matching on both the requested and normalized
model id.

## Packaging

Changeset targets `aio-proxy` and `@aio-proxy/plugin-sdk` as the published product packages,
alongside `@aio-proxy/server`, `@aio-proxy/cli`, `@aio-proxy/core`, and
`@aio-proxy/plugin-openai-chatgpt`. Minor.
