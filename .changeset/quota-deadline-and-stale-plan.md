---
'@aio-proxy/dashboard': patch
'@aio-proxy/server': patch
'aio-proxy': patch
---

Close two quota staleness holes

The quota read deadline now covers account-context preparation, not just the plugin's `quota.read`: the
account-options and credential schemas run through the plugin's own async validation first, so a plugin
that hung there held a Provider snapshot lease indefinitely and the read never timed out. And a Provider
reconfigured away from quota support no longer shows the previous account's subscription plan, which
TanStack Query had kept cached after the query was disabled.
