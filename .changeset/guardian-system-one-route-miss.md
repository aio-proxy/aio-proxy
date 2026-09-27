---
'@aio-proxy/core': patch
'@aio-proxy/plugin-openai-chatgpt': patch
'@aio-proxy/server': patch
'aio-proxy': patch
---

Optional Guardian System One strategies now work for eligible approval requests even when codex-auto-review is not independently configured as a route, while ordinary requests and the default strategy remain unchanged.
