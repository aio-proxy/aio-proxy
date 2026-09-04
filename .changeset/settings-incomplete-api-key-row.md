---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Report an API key row that has a label but no key instead of silently dropping it, so saving no longer succeeds without persisting the key.
