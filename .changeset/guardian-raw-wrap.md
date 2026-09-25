---
'aio-proxy': patch
'@aio-proxy/core': patch
'@aio-proxy/plugin-openai-chatgpt': patch
---

Guardian evaluation now runs on the OpenAI Responses provider selected for that request, not only on a ChatGPT transport. A direct allow or deny does not charge the selected provider; evaluation cost stays on the configured evaluation provider.
