---
'@aio-proxy/server': patch
'aio-proxy': patch
---

Reject dashboard and admin requests carrying a foreign `Host` header while no dashboard password is
set. A malicious page could previously rebind its own hostname to `127.0.0.1` and read every
unauthenticated dashboard endpoint — including the provider editor's real API keys, headers and proxy
credentials — because the loopback check trusts the browser's connection and the CSRF check ran only
on writes.
