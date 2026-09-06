---
'@aio-proxy/plugin-xai-grok': patch
'aio-proxy': patch
---

Keep `reasoning.summary` on Grok CLI `/v1/responses` requests

cli-chat-proxy now accepts `reasoning.summary`. The xAI plugin still strips
`previous_response_id` (Zero Data Retention 404) and the other Codex Desktop
fields that HTTP `/v1/responses` rejects, but it no longer deletes `summary`.
