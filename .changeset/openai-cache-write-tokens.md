---
'aio-proxy': patch
'@aio-proxy/server': patch
---

Record OpenAI Responses and Chat Completions `cache_write_tokens` on traces. Dashboard cache write previously showed N/A even when the upstream usage object included that field.
