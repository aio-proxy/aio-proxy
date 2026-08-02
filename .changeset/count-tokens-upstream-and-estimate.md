---
'aio-proxy': minor
'@aio-proxy/server': minor
---

server: return real upstream token counts for `/v1/messages/count_tokens` when a same-protocol raw provider is configured, and replace the `bytes/64` fallback with a character-class-weighted estimator
