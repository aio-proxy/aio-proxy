---
'@aio-proxy/dashboard': minor
'@aio-proxy/i18n': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'aio-proxy': minor
---

Add, relabel, and remove API keys from Settings, including a one-click generator for a fresh random key. Stored keys stay masked and are never sent back to the browser, and authored `{{env.NAME}}` key templates survive a write unchanged. Key writes carry the revision of the key list they were made against, so a write is rejected with `409 stale_api_keys` when the config changed underneath instead of silently rewriting a different key.
