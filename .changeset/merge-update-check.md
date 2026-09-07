---
'aio-proxy': patch
'@aio-proxy/core': patch
'@aio-proxy/server': patch
---

Update-check persist re-reads and merges on-disk state before writing so concurrent processes do not double-notify or overwrite a newer latest.
