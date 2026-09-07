---
'aio-proxy': patch
'@aio-proxy/core': patch
'@aio-proxy/server': patch
---

Update-check persist owns its lock file by process id and sends the OS notification after releasing that lock, so a long-running notify cannot be mistaken for a dead holder.
