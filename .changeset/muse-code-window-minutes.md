---
'aio-proxy': patch
'@aio-proxy/plugin-muse-code': patch
---

Muse Code quota bars now show the even-burn mark. The plugin read the window length from the
upstream response but never passed it on, so the dashboard knew when each window resets without
knowing how long it runs and had nothing to pace against.
