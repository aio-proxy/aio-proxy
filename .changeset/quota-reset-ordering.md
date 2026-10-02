---
'aio-proxy': minor
'@aio-proxy/core': minor
'@aio-proxy/types': minor
'@aio-proxy/server': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/i18n': minor
---

New opt-in `router.selection: quota-reset` (also a switch on the Dashboard Routing page): within each Provider priority tier, the subscription whose quota allowance expires soonest is tried first instead of the weighted draw, so allowance is not left to lapse on one subscription while another is drained. Session affinity still takes precedence, Providers without quota data follow in their weighted order, and nothing changes while the setting stays `weighted`.
