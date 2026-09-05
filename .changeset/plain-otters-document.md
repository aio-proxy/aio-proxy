---
'@aio-proxy/plugin-sdk': patch
'@aio-proxy/server': patch
'aio-proxy': patch
---

plugin-sdk: document and enforce the OAuth quota reset contract — report `resetCredits` only alongside a `reset` implementation, and treat every `reset` call as a new intentional redemption rather than a retry of the last one. A snapshot from an adapter with no `reset` now has its inventory dropped, so a plugin written against the older read-only contract cannot advertise a redemption it would refuse.
