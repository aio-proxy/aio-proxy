---
'@aio-proxy/plugin-openai-chatgpt': minor
'aio-proxy': minor
---

ChatGPT OAuth providers now discover models from the signed-in account's own Codex endpoint instead of a published `models.json` snapshot, so the exposed list matches what the account can actually call. Models the account cannot use no longer appear, and `gpt-5.3-codex-spark` — previously hidden by a `supported_in_api` filter that does not apply to ChatGPT accounts — is now available.

`gpt-image-2` is also exposed, and `/v1/images/generations` and `/v1/images/edits` now pass through to the ChatGPT image endpoints. JSON image requests are supported; `multipart/form-data` requests to `/v1/images/edits` are not, because the ChatGPT backend rejects that content type.
