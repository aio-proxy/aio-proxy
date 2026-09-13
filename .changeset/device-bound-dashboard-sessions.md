---
'@aio-proxy/server': patch
'@aio-proxy/core': patch
'aio-proxy': patch
---

Bind Dashboard login sessions to the device. Session tokens were signed with the stored password hash alone, so anyone who obtained that hash — including from a synced or backed-up configuration — could mint a token for every Dashboard API without knowing the password. Tokens are now signed with a device-local key kept outside the configuration, and existing sessions must log in again once.
