---
title: API overview
outline: false
---

# API reference

Use aio-proxy through the public HTTP endpoints in the sidebar. Each page documents one operation, including its parameters, response formats, and request examples.

## Your instance

Send requests to your own aio-proxy instance. Examples use `http://127.0.0.1:9317`; replace this with your deployment's URL. This documentation site does not send requests.

When authentication is enabled, supply your aio-proxy API key as a Bearer token. Never use an upstream provider's API key as the client credential.

## Protocol compatibility

Chat Completions, Responses, and Messages expose the supported portions of their respective protocols. Consult each operation's schema and compatibility notes; upstream features are not automatically supported.

Streaming opt-in depends on the operation: `stream: true` for chat-style requests, a separate `streamGenerateContent` route for Gemini, and provider-dependent `stream_format` for audio. Realtime uses WebSocket or SDP signaling, not SSE. Raw-provider streams keep the upstream format; media stream event schemas are not guaranteed by aio-proxy.

The reference also covers embeddings, token counting, images, audio, videos, System One evaluation, and realtime signaling. Availability depends on your configured providers. It excludes Dashboard and internal routes, and deliberately unsupported endpoints: response retrieval/deletion/cancellation/input-items, video listing/characters, realtime session/client-secret creation, realtime translations, and call accept/reject/refer.
