---
'@aio-proxy/plugin-openai-chatgpt': minor
'aio-proxy': minor
---

ChatGPT accounts can set a fixed user agent and optionally keep the inbound user agent when a model or image request comes from a Codex client. The fixed value is also used for realtime requests. Accounts that leave both unset keep the previous fixed user agent.
