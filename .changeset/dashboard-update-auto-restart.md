---
'@aio-proxy/cli': patch
'@aio-proxy/dashboard': patch
'aio-proxy': patch
---

Dashboard updates no longer keep Check for updates visible while an install is running. After a successful install, aio-proxy restarts itself so the new version takes over, and the dashboard keeps waiting and reloads instead of asking you to restart by hand.
