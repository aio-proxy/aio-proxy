---
'@aio-proxy/server': patch
'aio-proxy': patch
---

Route image generation for models whose image output is only declared by models.dev. A provider that lists an image model in `models` (or reaches it through an alias) no longer needs a hand-written `router.models` metadata entry to avoid a 501 `not_implemented`.
