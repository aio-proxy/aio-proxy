---
'@aio-proxy/core': minor
'@aio-proxy/types': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/i18n': patch
'aio-proxy': minor
---

dashboard: restore overview KPI change deltas, peaks, and note lines

The overview summary now includes an input/output token split, peak RPM/TPM,
and a previous-period summary so each KPI card can show a period-over-period
change badge plus its supporting note. The cost KPI now renders a compact
2-decimal currency value instead of full nano-USD precision.
