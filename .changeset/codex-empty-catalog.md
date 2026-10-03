---
'aio-proxy': patch
'@aio-proxy/cli': patch
---

Codex no longer fails to start with "model_catalog_json ... must contain at least one model" when model metadata is briefly unavailable. An empty model catalog is never written: the last good catalog is kept, or, with none, Codex uses its built-in catalog. The server logs a `codex.catalog_sync_failed` warning with code `empty_catalog` while the catalog stays empty.
