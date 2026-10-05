---
'aio-proxy': minor
'@aio-proxy/cli': minor
'@aio-proxy/cli-win32-x64': minor
'@aio-proxy/core': minor
'@aio-proxy/i18n': minor
---

The AIO Proxy desktop app is now available for Linux (AppImage, x86_64 and arm64) and Windows (x64 installer), with a tray menu, launch at login, the `aiop` command and signed in-app updates. The CLI now ships for Windows, where `aio-proxy service` is backed by a per-user scheduled task. On Linux and Windows, a service you stopped or uninstalled now stays stopped, and installing the Linux service without a systemd user session now says so instead of failing with an internal error.
