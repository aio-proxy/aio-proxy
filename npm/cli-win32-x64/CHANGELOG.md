# @aio-proxy/cli-win32-x64

## 0.42.1

No changes in this release.

## 0.42.0

No changes in this release.

## 0.41.1

No changes in this release.

## 0.41.0

No changes in this release.

## 0.40.0

### Minor Changes

- [#481](https://github.com/aio-proxy/aio-proxy/pull/481) [`0a41886`](https://github.com/aio-proxy/aio-proxy/commit/0a4188627a2bd86a56da5a73e07e41ab10a9b790) Thanks @baranwang - The AIO Proxy desktop app is now available for Linux (AppImage, x86_64 and arm64) and Windows (x64 installer), with a tray menu, launch at login, the `aiop` command and signed in-app updates. The CLI now ships for Windows, where `aio-proxy service` is backed by a per-user scheduled task. On Linux and Windows, a service you stopped or uninstalled now stays stopped, and installing the Linux service without a systemd user session now says so instead of failing with an internal error.
