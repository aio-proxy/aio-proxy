---
'aio-proxy': patch
'@aio-proxy/cli': patch
---

The desktop app's service check no longer waits about 2 seconds after it has its answer whenever the proxy is running, so the app opens, refreshes and finishes service actions faster.
