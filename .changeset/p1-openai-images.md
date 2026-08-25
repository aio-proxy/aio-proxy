---
'aio-proxy': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'@aio-proxy/plugin-sdk': minor
---

Add OpenAI Images inbound (`POST /v1/images/generations` and `POST /v1/images/edits`) with same-protocol raw passthrough and `imageModel` convert. Blank JSON `model` and multipart missing/empty/whitespace `model` look up `gpt-image-2` (CPA-compatible); multipart literal `null` is the explicit id `"null"`. Raw/convert use the resolved candidate id. Edits accept official-max JSON (`357_564_416`) and multipart (`851_048_559`) envelopes. Convert returns `501 unsupported_feature` for `image_url` or `file_id`, and enforces official mask size/format/alpha on uploaded bytes.
