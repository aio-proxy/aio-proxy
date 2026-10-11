---
'@aio-proxy/core': patch
'aio-proxy': patch
---

Finish cancelled request uploads promptly so their traces no longer remain in progress after clients disconnect.
