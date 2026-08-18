---
'@aio-proxy/types': patch
'aio-proxy': patch
---

types: list a provider's own model ids before its aliases. The derived route list that feeds `/v1/models`,
each provider's `clientModels`, and the provider editor's exposure preview put alias names first, so a
provider that renames one model pushed that alias above the models the user actually typed into the
whitelist. Direct ids now come first and aliases follow, in configuration order. Which models a provider
exposes is unchanged — only the order of the listing.
