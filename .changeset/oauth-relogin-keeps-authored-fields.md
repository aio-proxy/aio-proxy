---
'@aio-proxy/core': patch
'aio-proxy': patch
---

Harden the OAuth provider update contract so a partial patch cannot delete a provider's display name,
aliases, or model whitelist. Every field of a provider patch is optional on the wire, but rebuilding the
entry treated an omitted field as "clear it", so a caller that sent only the fields it owned dropped
config the user had authored elsewhere. The surfaces that ship today do send those fields — and a CLI
re-login sends no patch at all, so these three fields were already safe there — so this fixes the contract
rather than a flow you can hit. The rule it now follows is the one already fixed for per-model metadata: a
field a save does not mention keeps its stored value. `weight` is the deliberate exception, because an
omitted key is the only way to say "no weight", and clearing the display name now removes it instead of
storing an empty name.
