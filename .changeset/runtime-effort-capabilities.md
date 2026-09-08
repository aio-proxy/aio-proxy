---
'@aio-proxy/server': patch
'aio-proxy': patch
---

server: clamp reasoning effort using the capabilities a provider actually advertises. Providers whose model ids are not models.dev ids (plugin-backed ones in particular) looked like they supported nothing, so an effort level they reject was forwarded unchanged and the request failed. Their own advertised effort levels are now used first, with models.dev as the fallback.
