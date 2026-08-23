---
'@aio-proxy/dashboard': patch
'aio-proxy': patch
---

Show an OAuth provider's models as enabled when its whitelist is empty. An empty whitelist exposes the
whole discovered catalog at runtime, but the editor rendered every model unchecked — and the first
click then saved a one-model whitelist, silently disabling everything else.
