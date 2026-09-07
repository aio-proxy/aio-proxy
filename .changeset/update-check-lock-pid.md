---
'aio-proxy': patch
'@aio-proxy/core': patch
'@aio-proxy/server': patch
---

Update-check persist owns its lock file by process id and start time and sends the OS notification after releasing that lock, so a long-running notify cannot be mistaken for a dead holder and a reused PID cannot wedge later checks.
