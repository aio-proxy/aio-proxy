---
'@aio-proxy/core': minor
'@aio-proxy/plugin-cloudkit': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'aio-proxy': minor
---

Add selective configuration sync with an iCloud backend on macOS 14 and later, including required plugin settings, configuration history, and per-device local overrides. Synced OAuth accounts use coordinated refresh and remain pending on other devices until their adapter supports verified multi-device use. Plugin authors can register compatible sync backends through the SDK; signed native CloudKit and live account gates remain required before publishing.
