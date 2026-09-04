---
'@aio-proxy/cli': patch
'aio-proxy': patch
---

Attach the loopback OAuth-error rejection handler before the callback request so the test no longer fails intermittently on an unhandled rejection.
