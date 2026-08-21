---
'aio-proxy': patch
'@aio-proxy/plugin-sdk': patch
'@aio-proxy/types': patch
'@aio-proxy/plugin-cursor': patch
---

Cursor first-login now writes family aliases from AvailableModels, so clients can request names like `claude-sonnet-4-6` / `grok-4.6` and match thinking, effort, and speed onto the live wire slug.
