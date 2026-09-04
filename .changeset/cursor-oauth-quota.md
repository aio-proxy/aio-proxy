---
'@aio-proxy/plugin-cursor': minor
'aio-proxy': minor
---

cursor: report Cursor OAuth quota in the dashboard

The Cursor OAuth adapter now reads `cursor.com/api/usage-summary`, so its Provider card shows the quota ring: plan usage, the Auto and named-model lanes, the on-demand budget when the account has a cap, and the Cursor subscription tier, all resetting at the billing-cycle end. Accounts with a Grok Bot allowance also get its weekly lane; that read is best-effort and never fails the monthly bars. No re-login is needed — the session is derived from the access token already on file.
