---
'@aio-proxy/core': patch
'aio-proxy': patch
---

Refactor the multipart form reader used by OpenAI Images edits into a
protocol-agnostic module so future multipart ingresses can reuse it. Images edits
keep the same request limits, error shapes, and disk-spooling behavior.
