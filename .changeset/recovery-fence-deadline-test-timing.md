---
'@aio-proxy/core': patch
'aio-proxy': patch
---

Derive the recovery-fence action-phase test's sleep from its deadline so a slow acquisition no longer makes it fail on the timeout path it is not testing.
