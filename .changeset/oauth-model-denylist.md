---
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/dashboard': minor
'aio-proxy': minor
---

OAuth providers now hide models with `excludedModels` instead of a `models` whitelist. Leftover `models` keys are ignored and no longer restrict exposure — newly discovered catalog ids stay visible unless hidden. Plugin default aliases inherit at runtime and are no longer written into the config file.
