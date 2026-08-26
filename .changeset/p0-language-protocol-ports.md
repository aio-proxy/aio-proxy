---
'@aio-proxy/core': minor
'@aio-proxy/plugin-github-copilot': minor
'@aio-proxy/plugin-kimi-code': minor
'@aio-proxy/plugin-openai-chatgpt': minor
'aio-proxy': minor
---

openai: add Completions and Responses compact ports

`POST /v1/completions` and `POST /v1/responses/compact` now use the existing language-generation pipeline. Remaining official Responses resource operations return a protocol-shaped 501 instead of a generic 404. ChatGPT OAuth providers forward compact to the Codex compaction endpoint. GitHub Copilot and Kimi Code providers decline endpoints they do not serve so the request falls back instead of failing on a terminal upstream 404.
