---
'@aio-proxy/server': patch
'aio-proxy': patch
---

Keep the Settings page usable when an external edit leaves the config file unparseable: the read view falls back to the keys the proxy is still enforcing instead of failing, and a write attempted against the broken file is refused with a clear error rather than a 500.
