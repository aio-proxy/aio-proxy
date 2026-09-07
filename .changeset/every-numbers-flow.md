---
'aio-proxy': minor
'@aio-proxy/types': minor
'@aio-proxy/server': minor
'@aio-proxy/cli': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/core': minor
'@aio-proxy/i18n': minor
---

A running process checks npm `latest` on start, every 24 hours, and when the Dashboard mounts. It persists the result, prompts once per new version (Dashboard sidebar, CLI stderr banner, OS notification), and installs only after Update now or `aio-proxy upgrade`. Leftover `server.autoUpdate` in an existing config is ignored.
