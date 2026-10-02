---
'aio-proxy': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/plugin-kimi-code': minor
'@aio-proxy/plugin-muse-code': minor
'@aio-proxy/plugin-openai-chatgpt': minor
'@aio-proxy/plugin-cursor': minor
---

A Kimi Code, Muse Code, ChatGPT, or Cursor subscription whose quota window is known to be exhausted is now skipped for the models that window covers until it resets, instead of being attempted and failing on every request. Quota that is unknown or older than 10 minutes never skips a Provider. When every candidate is exhausted or cooling down, the client gets a 429 with `Retry-After` set to the earliest reset, and the request trace lists the skipped Providers and why.
