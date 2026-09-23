---
'@aio-proxy/server': patch
'aio-proxy': patch
---

Keep routed `codex-auto-review` in the Codex model list while leaving it hidden. Automatic review can resolve it, but it stays out of the model picker and is omitted when no enabled Provider exposes it.
