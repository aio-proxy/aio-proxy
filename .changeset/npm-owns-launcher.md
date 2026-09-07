---
'aio-proxy': patch
'@aio-proxy/cli': patch
---

Standalone and curl launches that only sit next to `npm`, or next to a leftover global `aio-proxy` package directory, are no longer recorded as npm-owned. The launcher must resolve into that package before a later Update now uses npm.
