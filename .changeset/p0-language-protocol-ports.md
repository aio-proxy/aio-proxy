---
'@aio-proxy/core': minor
'aio-proxy': minor
---

openai: add Completions and Responses compact ports

`POST /v1/completions` and `POST /v1/responses/compact` now use the existing language-generation pipeline. Remaining official Responses resource operations return a protocol-shaped 501 instead of a generic 404.
