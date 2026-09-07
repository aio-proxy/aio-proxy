---
'aio-proxy': patch
'@aio-proxy/plugin-cursor': patch
---

Fix Cursor OAuth account labels to use the account email after sign-in or credential refresh even when the access token omits it. If the account lookup is unavailable, keep the existing label without failing authentication.
