---
'@aio-proxy/dashboard': patch
'@aio-proxy/server': patch
'aio-proxy': patch
---

Refresh Provider quota at the right moment

A streamed response used to warm the server-side quota cache the instant the response object existed,
which is before upstream has accounted the tokens, so the reading it cached was the pre-request balance
and the read cooldown then held it for five minutes. The warm now runs once the response body has
finished streaming. The dashboard's quota query also polls while the Providers page is open, matching
the health query, so a warmed reading reaches the card instead of waiting for a remount.
