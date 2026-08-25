---
'aio-proxy': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'@aio-proxy/plugin-sdk': minor
---

Add OpenAI Images inbound (`POST /v1/images/generations` and JSON `POST /v1/images/edits`) with same-protocol raw passthrough and `imageModel` convert. Blank JSON `model` looks up `gpt-image-2` (CPA-compatible) and raw/convert use the resolved candidate id. JSON edits accept official-max envelopes; convert returns `501 unsupported_feature` for `image_url` or `file_id`.
