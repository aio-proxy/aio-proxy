---
'aio-proxy': patch
'@aio-proxy/cli': patch
---

The desktop app starts the proxy faster. Its service check no longer waits about 2 seconds after it has its answer whenever the proxy is running, runs alongside the app's startup checks instead of after them, and an automatic install or start skips two redundant service checks.
