---
'@aio-proxy/core': minor
'aio-proxy': minor
---

core: normalize and downgrade reasoning effort per upstream model capability

Inbound reasoning-effort values are now accepted leniently and clamped to what
each candidate upstream model actually advertises, on both the raw-passthrough
and AI SDK model-invocation paths. This fixes a `400 ... at output_config.effort`
error when Claude Code's ultracode mode sent effort `xhigh` to an upstream that
only supports `low`/`medium`/`high` — the request now downgrades to the highest
supported level instead of being rejected. Capability resolution is cache-only,
so a cold or slow models.dev never blocks the request (it falls back to
forwarding the client's value unchanged).
