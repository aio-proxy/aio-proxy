---
'aio-proxy': patch
'@aio-proxy/cli': patch
---

Standalone and curl launches that only sit next to `npm` are no longer recorded as npm-owned, so a later Update now does not install a separate npm package.
