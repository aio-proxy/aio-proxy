---
'@aio-proxy/plugin-openai-chatgpt': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/i18n': minor
'@aio-proxy/server': minor
'aio-proxy': minor
---

Redeem ChatGPT rate-limit reset credits from the Dashboard. The OpenAI ChatGPT plugin now implements the OAuth quota `reset` capability, the quota popup turns an available credit count into a confirmed redeem button, and the reading is invalidated afterwards so the spent credit disappears immediately. Only credits the upstream reports as available Codex rate-limit grants are counted.
