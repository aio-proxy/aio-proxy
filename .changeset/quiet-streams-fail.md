---
'@aio-proxy/core': patch
'@aio-proxy/plugin-sdk': patch
'aio-proxy': patch
---

core: terminate converted OpenAI Responses stream failures with `response.failed` and normalize cumulative OpenAI-compatible tool argument snapshots.
