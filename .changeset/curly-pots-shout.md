---
'@aio-proxy/plugin-openai-chatgpt': minor
'aio-proxy': minor
---

openai-chatgpt: report ChatGPT OAuth quota in the dashboard

The ChatGPT (Codex) OAuth adapter now reads `wham/usage`, so its Provider card shows the quota ring: the 5-hour and weekly windows, any model-specific limits the account reports (Codex Spark and the like), the subscription plan, and the available rate-limit reset credits.
