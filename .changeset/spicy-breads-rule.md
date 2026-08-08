---
'@aio-proxy/plugin-sdk': patch
'aio-proxy': patch
---

Normalize OpenAI Responses error events into response.failed events so Codex surfaces the upstream error instead of a generic disconnected stream.
