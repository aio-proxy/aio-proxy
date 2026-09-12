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

Add selective configuration sync with an iCloud backend on macOS 14 and later, including required plugin settings, configuration history, and per-device local overrides. Every provider, model rule and plugin in your configuration is listed for selection and joins together with the plugin settings it needs. Synced OAuth accounts use coordinated refresh, remain pending on other devices until their adapter supports verified multi-device use, and must be detached before you disconnect or switch backends so no device is left rotating a credential the others still follow. Plugin authors can register compatible sync backends through the SDK; signed native CloudKit and live account gates remain required before publishing.
Remote imports retry safely after interruptions while preserving newer local configuration and plugin-secret edits. The sync commands refuse to send credentials to a remote endpoint over plain HTTP, and an incoming provider that would send one of this device's `{{env.NAME}}` secrets somewhere you have not already approved stays pending for review.
