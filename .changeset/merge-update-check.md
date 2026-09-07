---
'aio-proxy': patch
'@aio-proxy/core': patch
'@aio-proxy/server': patch
---

Update-check persist takes a file lock, claims `notifiedVersion` before the OS notification, and treats a later successful registry result as authoritative so an npm `latest` rollback is recorded. A slower overlapping fetch still cannot overwrite a newer in-flight check.
