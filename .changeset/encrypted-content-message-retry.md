---
'@aio-proxy/core': patch
'aio-proxy': patch
---

Retry OpenAI Responses raw requests when the upstream rejects an unverifiable reasoning blob with `code: null` and only the message `The encrypted content for item rs_… could not be verified. Reason: Encrypted content could not be decrypted or parsed.`. That variant previously reached the client unchanged because the retry only matched `code: "invalid_encrypted_content"`. A `Signature expired` rejection still commits, since replaying the same body cannot fix it.
