---
'@aio-proxy/core': patch
'aio-proxy': patch
---

Preserve prompt-cache and reasoning token counts when converting a model
stream into OpenAI Responses. Cross-protocol Responses usage previously
reported those fields as 0 even when the upstream model returned them.
