---
'aio-proxy': patch
'@aio-proxy/cli': patch
---

Managed restart after a pnpm upgrade uses the `cli-*` binary from the global group that owns the active `aio-proxy` launcher. A leftover `global/<n>` or v11 isolated group is no longer chosen just because `readdir` yielded it first.
