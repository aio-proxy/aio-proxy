---
'@aio-proxy/core': patch
'aio-proxy': patch
---

core: fix proxied streaming passthrough dropping the request body. Bun 1.3.x
silently discards a `ReadableStream` request body when `fetch` uses a proxy, so
`api` providers with a `proxy` configured hung until timeout on streaming
requests (e.g. `openai-response` passthrough). `createProxyFetch` now buffers a
streamed request body to bytes before sending it through the proxy, so the body
survives without changing the streaming response. This lets the build toolchain
stay on the reproducible Bun 1.3.14 release.
