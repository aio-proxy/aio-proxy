---
'@aio-proxy/plugin-google-antigravity': patch
'aio-proxy': patch
---

Google Antigravity upstream failures now pass a short diagnostic through to the client. A request rejected because the account region is unsupported reports that reason instead of a generic request failure. Responses that carry anything besides the diagnostic stay masked.
