---
'@aio-proxy/server': patch
'aio-proxy': patch
---

Make an API key write idempotent: when a save commits but its response is lost, retrying it no longer authors the same credential twice.
