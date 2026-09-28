---
'aio-proxy': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'@aio-proxy/dashboard': minor
---

The routing page groups models by vendor using models.dev's display naming rules and filters model IDs and vendors in one row. Each model lists its failover tiers with every Provider's share of its tier (OAuth by service and account, API by protocol, AI SDK by package), marks shares that drift from the configured split, and flags models no Provider can serve. Providers that take no traffic stay listed with the reason. Tiers read as T1, T2, … on every routing surface, with their priority on hover. Editing a route is a full page instead of a drawer.
