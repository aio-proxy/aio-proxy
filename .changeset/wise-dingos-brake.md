---
'aio-proxy': patch
'@aio-proxy/cli': patch
---

Prevent duplicate desktop upgrade notifications when multiple instances use different data directories. Only a successfully sent notification suppresses repeat reminders for the same OS user when shared storage is available; failed delivery can be retried by another instance, and notifications still work if that storage cannot be written.
