---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Align the model metadata drawer with the editor demo. Visual-tab labels are prose
again (reasoning, context window, cache read, and so on) instead of config key
paths, and the JSON tab names a schema field when the draft is an object Zod
rejects instead of claiming it is not JSON. A failed models.dev slug catalog
response now surfaces as an error with Retry, rather than an empty catalog.
