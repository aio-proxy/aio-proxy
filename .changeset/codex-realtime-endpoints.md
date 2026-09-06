---
'aio-proxy': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/server': minor
'@aio-proxy/cli': minor
'@aio-proxy/plugin-openai-chatgpt': minor
---

Serve the Codex Live / Realtime endpoint family as signaling passthrough. `POST /v1/live`,
`POST /v1/realtime`, and `POST /v1/realtime/calls` forward an SDP offer to the ChatGPT Codex
realtime upstream and answer with the upstream's SDP, with `Location` rewritten to a proxy path.
`GET /v1/live/:call_id`, `GET /v1/realtime/calls/:call_id`, and `GET /v1/realtime` relay the
sideband WebSocket, and `POST /v1/realtime/calls/:call_id/hangup` ends a call through the same
upstream account that created it. WebRTC media is not relayed — the media plane stays a direct
client-to-upstream connection.

Plugins can now expose an optional `realtime` runtime capability (`models`, `fetch`, `dial`) and
receive the effective outbound proxy on their `RuntimeContext`, so a sideband dial honors the same
proxy configuration as ordinary requests. Realtime endpoints the ChatGPT upstream has no equivalent
for (`client_secrets`, `sessions`, `transcription_sessions`, `translations`, `accept`, `reject`,
`refer`) answer `501` with a diagnosable error code instead of `404`. A caller-supplied realtime
model id longer than 128 characters is refused with `400` `realtime_invalid_model` rather than
truncated, on both the create body (`model` / `session.model`) and `/v1/realtime`'s `model` query.

Realtime provider selection honors per-model overrides from `router.models[<model>].providers[<id>]`
for both provider priority and provider weight, matching ordinary routing. A direct
`GET /v1/realtime?model=<id>` selects providers by the model that connection will actually send
upstream, so a provider advertising only the Codex model is no longer handed an unrelated model id.

`@aio-proxy/server` now also exports Bun's `websocket` handler; an embedder that constructs its own
`Bun.serve` must pass it as the `websocket` option or every realtime sideband upgrade fails.
