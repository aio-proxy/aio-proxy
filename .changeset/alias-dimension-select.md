---
'aio-proxy': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
---

core: select alias targets from effort, thinking, and speed dimensions. A Gemini 1D variant key `off`/`OFF` no longer matches `thinkingLevel: "OFF"`; replace it with `{ "when": { "thinking": false }, "model": "…" }` (or drop the row and use the alias `model`) — shipped Antigravity defaults are unaffected.
