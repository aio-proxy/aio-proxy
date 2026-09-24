---
'aio-proxy': patch
'@aio-proxy/plugin-openai-chatgpt': patch
---

Guardian approval now keeps requests eligible when their transcript contains paired custom tool calls, instead of falling back before evaluation.
