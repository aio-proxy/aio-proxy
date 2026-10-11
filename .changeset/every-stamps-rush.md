---
'@aio-proxy/core': patch
'aio-proxy': patch
---

Reduce peak memory and processing overhead for large image-heavy Responses requests by reusing their wire document during raw forwarding and provider fallback. Preserve original bytes when no rewrite is needed, unknown fields, request limits, compressed uploads, and cancellation behavior.
