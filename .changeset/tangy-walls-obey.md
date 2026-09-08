---
'@aio-proxy/plugin-cursor': patch
'aio-proxy': patch
---

Cursor now returns explicit failures for unsupported native tools and completes rejected tool execution streams so the upstream turn can continue. Bounded protocol diagnostics help investigate remaining stalls.
