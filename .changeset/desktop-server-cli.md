---
'aio-proxy': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/cli': minor
'@aio-proxy/types': minor
'@aio-proxy/i18n': minor
'@aio-proxy/dashboard': minor
---

`aio-proxy service start` now starts a loaded-but-stopped launchd service and checks it really loaded, `service restart` waits for the old job to unload, and a service whose binary was removed no longer respawns in a loop. A stopping proxy exits within 3 seconds of a stop signal even with open connections. Groundwork for the upcoming macOS desktop app: a local summary endpoint and a discovery command. An app-managed install never self-upgrades or announces CLI updates, the Dashboard hides "Update now" when it can't be applied there, and `aio-proxy upgrade` from Homebrew or npm no longer restarts an app-owned service.
