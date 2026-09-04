---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Keep an unsaved API key when another writer's change forces a settings refetch, so a rejected save no longer discards the only copy of a generated key. Localize every config reload failure stage instead of interpolating the server's internal stage identifier into the translated message.
