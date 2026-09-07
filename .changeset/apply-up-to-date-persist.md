---
'aio-proxy': patch
'@aio-proxy/server': patch
'@aio-proxy/dashboard': patch
---

Update now that finds the running version already current writes that result to `update-check.json`, so the sidebar, a remount, and the CLI banner stop advertising a stale latest.
