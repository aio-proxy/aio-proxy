---
'@aio-proxy/core': patch
'aio-proxy': patch
---

core: accept `role: "system"` messages on the Anthropic Messages endpoint (matching the official SDK's `MessageParam` union) and surface Zod validation path detail in 400 responses without leaking request values
