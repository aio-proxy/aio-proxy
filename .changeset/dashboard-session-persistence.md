---
'@aio-proxy/dashboard': minor
'@aio-proxy/server': minor
'aio-proxy': minor
---

The Dashboard login now persists in the browser, so opening a new tab or restarting the browser no longer asks for the password again. The login renews itself while you keep using the Dashboard, and only expires after seven days without a visit, so regular users are no longer logged out. Logging out in one tab logs out every other tab, and changing `server.password` still invalidates the login on every device immediately.
