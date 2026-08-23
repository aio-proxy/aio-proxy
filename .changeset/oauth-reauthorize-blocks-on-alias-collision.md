---
'@aio-proxy/dashboard': patch
'aio-proxy': patch
---

Stop OAuth reauthorize from writing the provider while alias names still collide. The editor already blocked Save; reauthorize went through `save()` without that check, so last-wins serialization could drop a colliding row from the config.
