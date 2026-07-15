---
"@aio-proxy/cli": major
"@aio-proxy/plugin-sdk": major
"@aio-proxy/plugin-github-copilot": major
"@aio-proxy/plugin-openai-chatgpt": major
---

Replace vendor-specific OAuth support with a public OAuth plugin SDK, embedded GitHub Copilot and OpenAI ChatGPT plugins, host-owned authorization and vault persistence, and read-only plugin diagnostics.

This is a clean break: legacy OAuth provider configuration and stored credentials are not migrated. Remove legacy OAuth providers and log in again to create plugin-backed accounts.
