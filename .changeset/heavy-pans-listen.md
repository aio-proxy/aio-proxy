---
'@aio-proxy/core': patch
'aio-proxy': patch
---

Fix the overview dashboard reading day ranges from pruned trace spans

The `7d`/`30d`/`90d` overview ranges read from `trace_span`, which is pruned at a
hardcoded 45 days, so a `90d` selection silently showed only 45 days of data.
Day ranges now read the never-pruned `usage_daily` rollup; `24h` still uses
`trace_span` for hour-bucket precision.

Also fixes two divisor bugs on the same screen: `averageRpm`/`averageTpm` divided
by the whole window instead of the buckets that actually had data (understating
`90d` by ~11x), and the six KPI delta badges vanished entirely when the previous
window had no data instead of saying so.
