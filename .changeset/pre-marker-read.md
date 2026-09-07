---
'aio-proxy': patch
'@aio-proxy/cli': patch
---

A managed service whose unit is unreadable during the pre-marker migration no longer fails to start. Discovery and rewrite errors are both ignored so the proxy can boot.
