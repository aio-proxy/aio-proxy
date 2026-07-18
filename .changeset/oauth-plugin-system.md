---
"@aio-proxy/cli": major
"@aio-proxy/plugin-sdk": major
---

Replace vendor-specific OAuth support with a public OAuth plugin SDK, embedded GitHub Copilot and OpenAI ChatGPT plugins, host-owned authorization and vault persistence, and read-only plugin diagnostics.

This is a clean break: legacy OAuth provider configuration and stored credentials are not migrated. Remove legacy OAuth providers and log in again to create plugin-backed accounts.

OAuth capabilities can now expose validated icons, including an exact build-generated LobeHub static icon key type.

OAuth adapters can now expose validated quota snapshots and optional account-level reset operations through a snapshot-isolated host service.
