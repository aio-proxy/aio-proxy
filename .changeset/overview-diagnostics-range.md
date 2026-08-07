---
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/ui': patch
'aio-proxy': minor
---

dashboard: scope overview diagnostics to the selected range

Provider health and top model costs now follow the overview range query
instead of always reading all-time data. KPI values also use animated
NumberFlow rendering with exact-value tooltips when formatting rounds.
