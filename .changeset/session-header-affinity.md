---
'@aio-proxy/server': patch
'aio-proxy': patch
---

Fix image, audio, video, and embedding requests ignoring provider weight when the client sends a session header. That header pinned the capability to whichever provider answered first, so a backup that served a single failover kept the traffic instead of returning it to the recovered primary. These capabilities now spread across providers by weight as intended.
