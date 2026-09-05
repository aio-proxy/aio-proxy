---
'@aio-proxy/plugin-sdk': patch
'aio-proxy': patch
---

plugin-sdk: document the OAuth quota reset contract — report `resetCredits` only alongside a `reset` implementation, and treat every `reset` call as a new intentional redemption rather than a retry of the last one
