---
'aio-proxy': minor
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/i18n': minor
---

API and discoverable AI SDK Providers can set `syncModels: true` to follow upstream model lists without editing the config: models refresh every hour or on demand in the Dashboard, upstream outages and empty responses keep the last good list, and `excludedModels` hides exact model IDs while aliases can still target them. The Dashboard supports switching between manual and synced models, hiding models, and viewing the last refreshed time; hand-written `models` lists work as before.
