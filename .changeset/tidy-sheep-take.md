---
'@aio-proxy/types': patch
'@aio-proxy/ui': patch
'@aio-proxy/cli': patch
'@aio-proxy/dashboard': patch
'@aio-proxy/plugin-sdk': patch
'@aio-proxy/plugin-kimi-code': patch
'@aio-proxy/plugin-cursor': patch
'@aio-proxy/plugin-muse-code': patch
'@aio-proxy/plugin-github-copilot': patch
'@aio-proxy/plugin-openai-chatgpt': patch
'@aio-proxy/plugin-google-antigravity': patch
'@aio-proxy/plugin-xai-grok': patch
'aio-proxy': patch
---

The plugin SDK now exports shared abortableSleep and dedupeQuotaItemIds helpers, preserving OAuth cancellation reasons and provider-specific quota IDs. Removed unused UI and internal wrappers, plus the unused AioModelMessage and AioStreamPart schemas and associated types from @aio-proxy/types.
