---
'@aio-proxy/plugin-openrouter': minor
'@aio-proxy/shared': minor
'@aio-proxy/core': minor
'@aio-proxy/cli': minor
'@aio-proxy/server': minor
'aio-proxy': minor
---

Add a built-in OpenRouter OAuth plugin that signs in with PKCE, mints a durable user-controlled API key, discovers models, and reads remaining key credits. Loopback parse now requires callback `state` only when the opened authorize URL sent `state`, so OpenRouter (no state echo) can finish without weakening ChatGPT or Antigravity CSRF.
