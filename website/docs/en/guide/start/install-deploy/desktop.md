---
description: Install the AIO Proxy desktop app for macOS, Windows, or Linux. It runs the proxy for you and shows its status, usage, and quota from the menu bar or system tray.
---

# Desktop App

The AIO Proxy desktop app bundles the proxy, so you do not need Bun or the CLI: install the app and the proxy runs in the background, with its status, usage, and quota one click away in the menu bar or system tray.

The app is a companion, not a second Dashboard. Providers, routing, and API keys are still managed in the [Dashboard](../../observability/dashboard-overview), which the app opens in your browser.

---

## Download

| Platform | Requirements                     | Download                                                                                                                                                                                                                                |
| -------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | Apple Silicon, macOS 13 or later | [`.dmg`](https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/aio-proxy-arm64.dmg)                                                                                                                                     |
| Windows  | x64                              | [Installer (`.exe`)](https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/aio-proxy-x64-setup.exe)                                                                                                                     |
| Linux    | x86_64 or arm64                  | [AppImage x86_64](https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/aio-proxy-x86_64.AppImage) · [AppImage arm64](https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/aio-proxy-aarch64.AppImage) |

Older versions are on [GitHub Releases](https://github.com/aio-proxy/aio-proxy/releases). Intel Macs and other systems can use the [CLI](./installation).

---

## Install

### macOS

1. Open the `.dmg` and drag **AIO Proxy** into **Applications**.
2. Open **AIO Proxy** from Applications. Its icon appears in the menu bar.

:::warning Run it from Applications
The app only installs the service and the launch-at-login item when it runs from `/Applications` or `~/Applications`; the `aiop` command needs `/Applications`. Opened from the disk image or Downloads, it runs read-only and shows **Move to Applications**.
:::

### Windows

Run the installer. It installs for your user only, into `%LOCALAPPDATA%\AIO Proxy`, and needs no administrator rights. The app's icon appears in the notification area.

:::warning SmartScreen
The installer is not code-signed yet, so Windows SmartScreen may warn about it. Choose **More info**, then **Run anyway**.
:::

### Linux

Make the AppImage executable and run it:

```sh
chmod +x aio-proxy-*.AppImage
./aio-proxy-*.AppImage
```

Keep it in a folder you can write to, such as `~/Applications`, so the app can update itself. The tray icon needs a desktop with a system tray (StatusNotifierItem); on GNOME that means the AppIndicator extension. Without a tray, the panel opens as a regular window, and closing it quits the app while the proxy keeps running.

### First Launch

On first launch, if no proxy is installed yet, the app installs and starts it as a [background service](./service) on `http://127.0.0.1:9317`. It uses the same `~/.aio-proxy/config.jsonc` as the CLI, so continue with [Quick Start](../getting-started) to add your first Provider.

---

## Using the App

- **Click the icon** to open the panel: proxy status and endpoint, usage and cost for a time window you pick, Provider quota with reset times, and a 12-month activity heatmap. **Open Dashboard** is at the bottom. On Linux desktops where a click opens the menu, choose **Open Panel**.
- **Right-click the icon** (or use **⋯** in the panel) for actions: **Start**, **Stop**, **Restart**, **Reload config**, **Open logs**, **Open at login**, and **Check for Updates…**. Only the actions that apply to the current state are listed.

### Existing CLI Installs

If you already run the proxy with `aio-proxy service install`, the app shows that service as **managed by the aio-proxy CLI** and never changes it on its own. Start, Stop, and Restart still work when you click them.

### The `aiop` Command

If your shell has no `aiop` command, the menu offers **Install aiop command**. It points `aiop` at the CLI bundled in the app, so the command stays in step with app updates. An `aiop` or `aio-proxy` you installed another way is left alone.

| Platform | Where it goes                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| macOS    | `/usr/local/bin/aiop`, after an admin prompt. Needs the app in `/Applications` and `/usr/local/bin` on your `PATH`.          |
| Windows  | A shim in `%LOCALAPPDATA%\aio-proxy-desktop\bin\shims`, added to the end of your user `PATH`. Open a new terminal to use it. |
| Linux    | `~/.local/bin/aiop`. Needs `~/.local/bin` on your `PATH`.                                                                    |

---

## Updates

The app checks for updates itself and verifies each one's signature. When one is ready, the panel shows **Update to &lt;version&gt;…**; you can also choose **Check for Updates…** from the menu. After updating, the app restarts the proxy it manages on the new version, which briefly interrupts in-flight requests.

---

## Uninstall

Quitting the app leaves the proxy running, because the background service, not the app, owns it. Your configuration in `~/.aio-proxy` is kept on every platform.

- **macOS:** remove the service with the CLI bundled in the app (use `~/Applications` instead if you installed it there), then quit the app and move it to the Trash:

  ```sh
  "/Applications/AIO Proxy.app/Contents/MacOS/aio-proxy" service uninstall
  ```

  If you installed the `aiop` command, also remove `/usr/local/bin/aiop`, and `/usr/local/bin/aio-proxy` if it links into the app.

- **Windows:** uninstall **AIO Proxy** from **Settings › Apps**. The uninstaller also removes the service the app installed, the `aiop` command, and the login item.

- **Linux:** an AppImage has no uninstaller. Remove the service first, then delete the AppImage and `~/.local/share/aio-proxy-desktop`:

  ```sh
  ~/.local/share/aio-proxy-desktop/bin/aio-proxy service uninstall
  ```

The app's own log is under `~/Library/Logs/aio-proxy-desktop` on macOS, `%LOCALAPPDATA%\aio-proxy-desktop\logs` on Windows, and `~/.local/state/aio-proxy-desktop` on Linux.
