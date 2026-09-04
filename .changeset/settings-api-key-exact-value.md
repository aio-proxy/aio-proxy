---
'@aio-proxy/dashboard': patch
'@aio-proxy/server': patch
'aio-proxy': patch
---

Store a new API key exactly as entered instead of trimming it, including a key made up entirely of whitespace, and author every submitted key even when a retained row already holds that credential.
