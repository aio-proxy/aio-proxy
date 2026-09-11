---
'@aio-proxy/plugin-google-antigravity': minor
'@aio-proxy/plugin-github-copilot': minor
'@aio-proxy/plugin-openai-chatgpt': minor
'@aio-proxy/plugin-claude-code': minor
'@aio-proxy/plugin-openrouter': minor
'@aio-proxy/plugin-cloudkit': minor
'@aio-proxy/plugin-kimi-code': minor
'@aio-proxy/plugin-muse-code': minor
'@aio-proxy/plugin-xai-grok': minor
'@aio-proxy/plugin-cursor': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/i18n': minor
'@aio-proxy/cli': minor
'aio-proxy': minor
---

Add selective configuration sync with an iCloud backend on macOS 14 and later, including required plugin settings, configuration history, and per-device local overrides. Synced OAuth accounts use coordinated refresh and remain pending on other devices until their adapter supports verified multi-device use. Plugin authors can register compatible sync backends through the SDK; signed native CloudKit and live account gates remain required before publishing.
Remote imports retry safely after interruptions while preserving newer local configuration and plugin-secret edits.
