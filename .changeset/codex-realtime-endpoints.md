---
'aio-proxy': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/server': minor
'@aio-proxy/cli': minor
'@aio-proxy/plugin-openai-chatgpt': minor
---

Serve the Codex Live / Realtime endpoint family as signaling passthrough. `POST /v1/live`,
`POST /v1/realtime` and `POST /v1/realtime/calls` forward an SDP offer to the ChatGPT Codex realtime
upstream and answer with its SDP; `GET /v1/live/:call_id`, `GET /v1/realtime/calls/:call_id` and
`GET /v1/realtime` relay the sideband WebSocket, with provider selection, per-model overrides and
failover matching ordinary routing. Plugins can serve realtime through a new optional `realtime`
runtime capability (`models`, `fetch`, `dial`). WebRTC media stays a direct client-to-upstream
connection, and endpoints the ChatGPT upstream has no equivalent for answer `501`. An embedder that
builds its own `Bun.serve` must now pass `@aio-proxy/server`'s exported `websocket` handler.
