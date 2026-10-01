---
'aio-proxy': patch
'@aio-proxy/dashboard': patch
'@aio-proxy/ui': patch
---

The dashboard now waits out a brief server restart instead of showing "Dashboard unavailable" until reloaded. On the Routing page, token limits and prices follow the dashboard language (`128K`, `$2.00`) instead of the system one, traffic charts name Providers instead of showing their IDs, API Providers no longer list their protocol, and an empty traffic chart gets a proper empty state. Mixed CJK and Latin text is now auto-spaced.
