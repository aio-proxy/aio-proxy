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

### Outbound proxy

Provider and global proxy configuration is applied today by wrapping *fetch* with Bun's `proxy`
option (`createProxyFetch`). A plugin-constructed `new WebSocket(...)` inherits nothing from that
wrapper, so sideband would connect directly while signaling went through the configured proxy.
Bun's `WebSocket` constructor accepts both `headers` and `proxy`, so the plugin runtime must receive
the effective proxy at construction — the same value `createProxyFetch` is given — and `dial` must
apply it. Threading it through `RealtimeDialInput` instead would put host transport configuration in
a per-request field; the proxy is provider configuration, so it belongs on the runtime.

## Provider selection

Eligibility: the provider is enabled, exposes `realtime`, its realtime `models` include the
normalized model, its effective weight is non-zero, and the requested model is not excluded by
router model policy. Ordering is deterministic: priority descending, then weight descending, then
provider ID. Weighted random draw is deliberately absent in this phase; **zero-weight and
exclusion filtering are not**, because those are eligibility rules rather than distribution rules.

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
2. Buffer the body once under the existing request-size limit. Accepted content types:
   `application/sdp`, `text/plain`, `application/json`, `multipart/form-data`.
3. Extract the requested model; compute the normalized model for selection.
4. Select ordered candidates.
5. Attempt candidates in order, constructing a **fresh `Request` per attempt** from the buffered
   body — a fetch body is single-use and cannot be replayed. Cancel every losing response body.
6. Validate the winning response before committing (below).
7. Record the call, rewrite `Location` to the inbound path's style, and return the upstream status,
   content type, and body verbatim.

**Retry policy.** Retry on transport failure and on a response that fails validation. Do not retry
after any bytes of a successful answer have been exposed. Stop immediately on caller abort. Bound
total attempts. A failed attempt does not prove the upstream allocated nothing, so an ambiguous
failure followed by a successful retry may leave an orphaned upstream call; this is documented, not
prevented.

**Success validation.** A 2xx alone is insufficient. The response must carry a usable body and a
`Location` from which a call ID matching `^[A-Za-z0-9_-]{1,128}$` can be extracted. `Location` is
parsed as a URL or relative reference, including the query-parameter form, and its **host is never
used as a future connection target** — sideband and hangup targets come from the plugin. A 204, an
empty body, or a missing or unparseable `Location` is a failed attempt.

### Call store

Record: call ID, provider ID, **account identity and generation**, normalized model, requested
model, inbound style, caller owner, creation time, and current attachment.

Pinning `providerId` alone is insufficient: a re-login rebuilds the runtime under the same Provider
ID, so a call created under account A could later attach under account B. The record therefore pins
account identity and generation. Token refresh for the same account remains valid. Re-login,
removal, disabling, and config reload invalidate the pin, and the call answers `503`.

**Caller ownership.** `/v1/*` authentication establishes that a caller may use the proxy, not that
it owns a given call. Sideband and hangup verify the caller matches the creator; a mismatch is
`403`. Without this, any authenticated caller holding a call ID could attach or hang up.

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
indefinitely when no further creates happen. Expiry removes routing for future control requests
and does not attempt to tear down media. A capacity cap bounds records created inside one TTL
window; cleanup also runs on hangup and on shutdown.

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
length** — a sliced view must not forward its whole backing buffer. The pre-open buffer is bounded,
as is per-direction in-flight data behind a slow peer; the dial has a deadline; overflow closes the
connection rather than growing a queue.

Teardown is normalized and idempotent. "Propagate code and reason" is not a valid blanket rule:
codes such as 1006 cannot be sent, reasons are byte-limited, and the destination API restricts
codes. Teardown also covers an upstream that finishes connecting after the downstream has already
gone away.

### WebSocket wiring

The route module imports `upgradeWebSocket` and `websocket` from `hono/bun` directly.
`createBunWebSocket()` in this Hono version returns those same module-level bindings, so a
singleton factory adds nothing. `createServer` re-exports `websocket`, and `Bun.serve` in
`packages/cli/src/run/run.ts` passes it alongside the existing `fetch: app.fetch`.

`fetch: app.fetch` must keep receiving Bun's second argument: `upgradeWebSocket` reaches the server
through `c.env`, so a wrapper that forwards only the request would break upgrades.

Three adapter constraints, verified against the resolved Hono version:

- The handler dispatches `open`, `message`, and `close` only. There is **no `onError`**; failures
  surface through `close` or a rejected dial.
- Lifecycle callbacks are not awaited, so an async `onOpen` must handle its own rejection.
- `WSContext.send` discards Bun's backpressure result and exposes no `drain`, and a retained
  `WSContext` holds a `readyState` snapshot — a context captured at open is not a live liveness
  check.

## Errors

Every response uses `{"error":{"message","type","param":null,"code"}}`. Codes:
`invalid_call_id`, `realtime_call_not_found`, `realtime_call_busy`,
`realtime_call_scope_mismatch`, `realtime_capability_not_supported`,
`realtime_upstream_unavailable`, `codex_auth_unavailable`, `websocket_upgrade_required`.

## Observability

Realtime bypasses the pipeline, so it produces no trace span. This phase emits `logServerEvent`
records for call created, call failed, sideband opened, and sideband closed. **SDP bodies are never
recorded**, matching the existing allowlisted-diagnostics rule. Usage capture is deferred; note
that standard Realtime does exchange response usage, so "no token metric exists" would be wrong as
a permanent justification.

## Testing

Behavior-level, colocated with their modules.

**Production wiring.** Start the real app with its exported Bun `websocket` handler and the real
auth middleware, and complete an actual upgrade. `app.request()` cannot prove the production
upgrade path works, because it never goes through `server.upgrade`.

**Call store.** Reserve/release across each failure path: plain GET then a valid upgrade; failed
dial then a successful retry; concurrent attachments yielding `409`; a superseded socket's late
close not releasing a newer attachment; hangup during an active attachment; expiry observed on
lookup with no intervening create; capacity exhaustion.

**Relay lifecycle.** Upstream greeting arriving before the downstream is ready; downstream
disconnect mid-dial; upstream handshake rejection mapped pre-upgrade; abnormal close; slow peer and
buffer overflow; binary frames preserved at exact byte length.

**Routing identity.** Sideband dials the creating provider even when another has higher priority;
re-login under the same Provider ID invalidates the pin; token refresh for the same account does
not; provider removal yields `503`; a different caller attaching or hanging up gets `403`.

**Plugin transport.** Each create alias reaches the exact upstream host, path, and query, including
`intent` and `architecture` surviving an inbound request with no query; hangup targets
`api.openai.com`; signaling rewrites `session.model` while direct preserves the requested model; an
unmapped realtime path fails closed; the configured outbound proxy applies to both `fetch` and
`dial`; caller credentials never reach upstream.

**Signaling and state.** Missing or unparseable `Location`; 2xx with an empty body; body replayed
correctly on fallback to a second provider; caller abort stops the loop; `Location` rewritten per
inbound style; selector skips disabled, non-realtime, zero-weight, and excluded candidates.

## Packaging

Changeset targets `aio-proxy` and `@aio-proxy/plugin-sdk` as the published product packages,
alongside `@aio-proxy/server`, `@aio-proxy/cli`, `@aio-proxy/core`, and
`@aio-proxy/plugin-openai-chatgpt`. Minor.
