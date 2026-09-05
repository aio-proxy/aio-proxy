---
'aio-proxy': patch
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'@aio-proxy/core': patch
'@aio-proxy/types': patch
---

Show default routing tiers and same-tier weight percentages in an inset layer beneath each Provider card, including the tier number when there is only one tier. Keep the last 24 hours of requests, success rate, P95 latency, and output throughput together in the main card. Share compact duration formatting across Provider cards, overview health, and traces, automatically switching between ms, s, min, h, and d.

Calculate throughput from successful requests with recorded output tokens and positive durations, weighting the last 24 hours by request duration.
