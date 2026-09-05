---
'aio-proxy': patch
---

Serve the config JSON Schema from `@aio-proxy/types` instead of duplicating it in the launcher package.

`@aio-proxy/types` is a published package and already exports the generated schema, so the `aio-proxy` launcher no longer copies it in at pack time. A bootstrapped `config.jsonc` now gets `"$schema": "https://unpkg.com/@aio-proxy/types/config.schema.json"` — unpinned, because nothing rewrites that line after bootstrap and a pinned version would go stale as the schema grows.

Existing configs keep working: they point at a released version whose tarball still carries the old copy. Update the line to the new URL to keep editor completion and validation current on future releases.
