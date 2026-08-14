---
'@aio-proxy/server': patch
'aio-proxy': patch
---

Serve the provider editor its per-model `metadata.extend` unresolved. The edit view read the
runtime config, where `extend` has already been merged into a flat copy of the model's models.dev
entry, so opening a provider and saving it froze that copy into the config file and cut the model
loose from the catalog it was tracking.
