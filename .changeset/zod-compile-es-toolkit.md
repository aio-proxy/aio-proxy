---
'aio-proxy': patch
'@aio-proxy/plugin-sdk': patch
'@aio-proxy/core': patch
'@aio-proxy/server': patch
'@aio-proxy/types': patch
'@aio-proxy/cli': patch
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'@aio-proxy/plugin-openai-chatgpt': patch
'@aio-proxy/plugin-google-antigravity': patch
'@aio-proxy/plugin-cursor': patch
'@aio-proxy/plugin-kimi-code': patch
'@aio-proxy/plugin-xai-grok': patch
'@aio-proxy/plugin-github-copilot': patch
---

Upgrade Zod to 4.5 and compile inbound protocol request schemas with `z.compile()` (except OpenAI Responses, whose unknown-item transform logs). Upgrade es-toolkit to 1.52, share one `isRecord` helper, and replace spread-Set arrays with `uniq`.
