---
'aio-proxy': patch
'@aio-proxy/plugin-openai-chatgpt': patch
---

ChatGPT requests now keep a stable upstream session when clients supply session identifiers or prompt cache keys. Previously each request replaced the session with a random identifier, preventing repeated prompts from reliably reusing the upstream cache.
