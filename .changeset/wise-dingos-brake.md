---
'aio-proxy': patch
'@aio-proxy/cli': patch
---

Prevent duplicate desktop upgrade notifications when multiple instances use different data directories. Only a newer release triggers another notification for the same OS user.
