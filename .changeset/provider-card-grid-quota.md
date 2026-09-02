---
'@aio-proxy/plugin-kimi-code': minor
'@aio-proxy/plugin-xai-grok': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/cli': minor
'@aio-proxy/i18n': minor
'@aio-proxy/ui': minor
'aio-proxy': minor
---

Redesign the dashboard Provider list as a card grid and surface OAuth remaining quota.

Each Provider — including each OAuth account — is now one card showing its name, kind, protocols,
plan, routing priority and weight, 24-hour success rate and p95 latency, model count, and request
count, with search and availability/enablement/kind filters replacing the old table's pagination and
grouping. OAuth Providers whose plugin exposes a quota capability show a remaining-quota ring that
opens a detail dialog with one bar per quota window that reports a remaining amount.

The quota read is cached in memory behind a per-provider five-minute cooldown, refreshed
asynchronously after a Provider answers a model request, and exposed at
`QUERY /dashboard/api/providers/:id/quota`; the dialog's refresh button bypasses the cooldown.
`OAuthQuotaSnapshot` gains an optional `plan`, which `kimi-code` and `xai-grok` now populate, and
`xai-grok` also reports per-product usage. Dashboard Provider summaries gain `protocols` and
`hasQuota` in place of the single `protocol` field.
