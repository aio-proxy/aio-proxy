---
'aio-proxy': minor
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
---

feat: per-provider model metadata & cost overrides

Providers can now declare a `metadata` map keyed by upstream model id to override client-facing model metadata (name, description, token limits, capabilities) and cost accounting. User config wins over models.dev auto-discovery. Billing uses the actual hit channel's configured `cost`, and each usage row records its `priceSource` (`config`/`models-dev`/`default`). A new `router.modelContextAggregation` (`min` default / `max`) reconciles the context window when multiple providers expose the same public model.
