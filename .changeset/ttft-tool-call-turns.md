---
'aio-proxy': patch
'@aio-proxy/server': patch
---

Time to first token is now recorded for streamed responses that only produce a tool call. Agent turns that streamed tool-call arguments without any text or reasoning summary previously showed no TTFT in the dashboard.
