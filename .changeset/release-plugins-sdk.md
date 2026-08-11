---
'aio-proxy': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/core': minor
'@aio-proxy/cli': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'@aio-proxy/i18n': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/plugin-cursor': minor
'@aio-proxy/plugin-github-copilot': minor
'@aio-proxy/plugin-google-antigravity': minor
'@aio-proxy/plugin-kimi-code': minor
'@aio-proxy/plugin-openai-chatgpt': minor
'@aio-proxy/plugin-xai-grok': minor
---

Plugins move display identity into descriptor metadata (`displayName` / `accountLabel`; remove legacy `label` and OAuth capability icons). Add Cursor account OAuth/provider support. Normalize OpenAI Responses errors to `response.failed` for Codex.
