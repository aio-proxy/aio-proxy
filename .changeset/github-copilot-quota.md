---
'@aio-proxy/plugin-github-copilot': minor
'aio-proxy': minor
---

github-copilot: report Copilot OAuth quota in the dashboard

The GitHub Copilot OAuth adapter now reads `copilot_internal/user`, so its Provider card shows the quota ring: the premium-request and chat allowances, any other window the account reports, the monthly reset date, and the Copilot plan. Seats with an unlimited or token-billed entitlement report no metered window rather than a misleading full bar.
