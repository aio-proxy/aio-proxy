---
'@aio-proxy/types': patch
'@aio-proxy/core': patch
'@aio-proxy/server': patch
'@aio-proxy/dashboard': patch
'aio-proxy': patch
---

Plugin default aliases now respect a provider's `models` whitelist, so a background catalog refresh can no longer insert an alias target outside it and drop the whole provider out of routing.
