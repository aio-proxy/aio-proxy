---
'@aio-proxy/server': patch
'aio-proxy': patch
---

Stop an unbounded snapshot-rebuild loop when the models.dev catalog cache expires. The cold-catalog warm now refreshes the provider catalog the staleness check actually reads, instead of a per-model cache that could already be warm — which previously left the check false forever and requeued a rebuild on every pass.
