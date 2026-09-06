---
'aio-proxy': minor
'@aio-proxy/types': minor
'@aio-proxy/server': minor
'@aio-proxy/cli': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/i18n': minor
---

Settings: add an Automatic updates toggle (off by default) and Update now. When enabled, a managed launchd/systemd service checks npm `latest` on startup and every 24 hours and runs the existing `aio-proxy upgrade` path. Foreground `aio-proxy run` persists the flag but does not auto-install.
