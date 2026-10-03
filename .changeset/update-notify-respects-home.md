---
'aio-proxy': patch
'@aio-proxy/cli': patch
---

Desktop update notifications now record their state under `AIO_PROXY_HOME` instead of always writing to `~/.aio-proxy`.
