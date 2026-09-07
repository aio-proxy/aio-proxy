---
'aio-proxy': patch
'@aio-proxy/cli': patch
---

Standalone and curl launches that only sit next to `npm` / `bun` / `pnpm`, or in a conventional manager directory such as `~/.bun/bin` or a PNPM home, are no longer recorded as package-owned. The launcher must resolve into that manager's `aio-proxy` package before a later Update now uses it.
