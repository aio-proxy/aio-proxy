---
'@aio-proxy/dashboard': minor
'@aio-proxy/server': minor
'aio-proxy': minor
---

The Dashboard login now persists in the browser, so opening a new tab or restarting the browser no longer asks for the password again. The login renews itself while you keep using the Dashboard, so visiting at least once every 6 days keeps you signed in, and an unused login expires after seven days. Logging out in one tab logs out every other tab, and changing `server.password` still invalidates the login on every device immediately.
