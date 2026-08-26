---
'@aio-proxy/core': minor
'@aio-proxy/plugin-github-copilot': minor
'@aio-proxy/plugin-kimi-code': minor
'@aio-proxy/plugin-openai-chatgpt': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/server': minor
'aio-proxy': minor
---

openai: add Completions and Responses compact ports

`POST /v1/completions` and `POST /v1/responses/compact` now use the existing language-generation pipeline. Remaining official Responses resource operations return a protocol-shaped 501 instead of a generic 404. ChatGPT OAuth providers forward compact to the Codex compaction endpoint. GitHub Copilot and Kimi Code providers decline endpoints they do not serve so the same candidate can convert through its language model, or a later provider can take the request. Legacy Completions streams omit usage unless the client can opt in.
