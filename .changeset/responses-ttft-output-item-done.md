---
'aio-proxy': patch
'@aio-proxy/server': patch
---

Record TTFT for OpenAI Responses streams that deliver the first text or reasoning in `response.output_item.done` instead of incremental `*.delta` events. Tool-only and empty items still omit TTFT.
