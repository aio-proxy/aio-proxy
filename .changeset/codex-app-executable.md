---
'aio-proxy': patch
'@aio-proxy/cli': patch
'@aio-proxy/i18n': patch
---

`aiop agent configure codex` finds the Codex CLI shipped inside the ChatGPT app when `codex` is not on `PATH`. A missing CLI is reported directly instead of as an unexpected internal error.
