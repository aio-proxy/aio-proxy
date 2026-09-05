---
'@aio-proxy/plugin-openai-chatgpt': patch
'aio-proxy': patch
---

Surface the newest ChatGPT (Codex) models again. The pinned `codex-tui` client version was stale, and the upstream model catalog gates each model on its `minimal_client_version`, so the `gpt-5.6` family and `gpt-6-astra` were silently missing from ChatGPT OAuth Providers.
