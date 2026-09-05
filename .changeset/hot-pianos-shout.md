---
'aio-proxy': patch
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'@aio-proxy/core': patch
'@aio-proxy/types': patch
---

Show default routing tiers and same-tier weight percentages in an inset layer beneath each Provider card, including the tier number when there is only one tier. Keep the last 24 hours of requests, throughput (total input plus output tokens), success rate, and P95 latency together in the main card, with throughput immediately after requests. Share localized compact duration formatting across Provider cards, overview health, and traces, automatically switching between milliseconds, seconds, minutes, hours, and days, including when rounding reaches the next unit.

Count input plus output tokens over the last 24 hours with exact integer arithmetic, independently of request duration or upstream-reported total token accounting. Show zero tokens for Providers without traffic after diagnostics load successfully, while leaving unavailable success rate and latency metrics blank.
