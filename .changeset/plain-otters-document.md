---
'@aio-proxy/plugin-sdk': patch
'@aio-proxy/server': patch
'aio-proxy': patch
---

plugin-sdk: document and enforce the OAuth quota reset contract — report `resetCredits` only alongside a `reset` implementation, and treat every `reset` call as a new intentional redemption rather than a retry of the last one. A snapshot from an adapter with no `reset` now has its inventory dropped, so a plugin written against the older read-only contract cannot advertise a redemption it would refuse. Absence and zero are also distinct answers now: `{ availableCount: 0 }` reports an inventory read as empty, while omitting the field reports one that could not be read, and a redemption against the latter fails as retryable instead of telling the user their credit is spent.
