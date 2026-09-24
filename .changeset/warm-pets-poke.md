---
'aio-proxy': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/core': minor
'@aio-proxy/types': minor
'@aio-proxy/server': minor
'@aio-proxy/plugin-openai-chatgpt': minor
'@aio-proxy/cli': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/i18n': minor
---

ChatGPT OAuth now offers optional Guardian approval strategies that evaluate with a selected System One Provider and model. The default keeps Codex behavior, and supported System One decisions can be final or send denials to the original model for review; unavailable evaluations fall back safely.
