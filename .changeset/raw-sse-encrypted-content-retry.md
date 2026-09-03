---
'aio-proxy': patch
'@aio-proxy/core': patch
'@aio-proxy/server': patch
---

Raw OpenAI Responses requests that fail with `invalid_encrypted_content` before any output are now retried once on the same provider. Plaintext encrypted slots become plain text, and opaque reasoning blobs are dropped when that is all that remains, so the client no longer sees a stream that disconnects before completion.
