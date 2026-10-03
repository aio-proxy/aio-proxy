---
description: Install the AIO Proxy macOS menu-bar app, which runs the proxy for you and shows its status, usage, and quota at a glance.
---

# Desktop App (macOS)

The AIO Proxy desktop app is a menu-bar companion for macOS. It bundles the proxy, so you do not need Bun or the CLI: install the app and the proxy runs in the background, with its status, usage, and quota one click away in the menu bar.

The app is a companion, not a second Dashboard. Providers, routing, and API keys are still managed in the [Dashboard](../../observability/dashboard-overview), which the app opens in your browser.

**Requirements:** macOS 13 or later on Apple Silicon. Intel Macs can use the [CLI](./installation).

---

## Install

1. [Download the latest `.dmg`](https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/aio-proxy-arm64.dmg).
2. Open it and drag **AIO Proxy** into **Applications**.
3. Open **AIO Proxy** from Applications. Its icon appears in the menu bar.

On first launch, if no proxy is installed yet, the app installs and starts it as a [background service](./service) on `http://127.0.0.1:9317`. It uses the same `~/.aio-proxy/config.jsonc` as the CLI, so continue with [Quick Start](../getting-started) to add your first Provider.

:::warning Run it from Applications
The app only installs the service and the launch-at-login item when it runs from `/Applications` or `~/Applications`; the `aiop` command needs `/Applications`. Opened from the disk image or Downloads, it runs read-only and shows **Move to Applications**.
:::

---

## Using the App

- **Click the menu-bar icon** to open the panel: proxy status and endpoint, usage and cost for a time window you pick, Provider quota with reset times, and a 12-month activity heatmap. **Open Dashboard** is at the bottom.
- **Right-click the icon** (or use **⋯** in the panel) for actions: **Start**, **Stop**, **Restart**, **Reload config**, **Open logs**, **Open at login**, and **Check for Updates…**. Only the actions that apply to the current state are listed.
- The icon dims when the proxy is down and shows a dot when something needs attention, such as a failing Provider.

### Existing CLI Installs

If you already run the proxy with `aio-proxy service install`, the app shows that service as **managed by the aio-proxy CLI** and never changes it on its own. Start, Stop, and Restart still work when you click them.

### The `aiop` Command

If your shell has no `aiop` command, the right-click menu offers **Install aiop command**. After an admin prompt, it links `/usr/local/bin/aiop` to the CLI bundled in the app, so the command stays in step with app updates. An `aiop` or `aio-proxy` you installed another way is left alone. This needs the app in `/Applications` and `/usr/local/bin` on your `PATH`.

---

## Updates

The app checks for updates itself. When one is ready, the panel shows **Update to &lt;version&gt;…**; you can also choose **Check for Updates…** from the menu. After **Install and Relaunch**, the app restarts the proxy it manages on the new version. Updating briefly interrupts in-flight requests.

---

## Uninstall

Quitting the app leaves the proxy running, because the background service, not the app, owns it. To remove both, run the CLI bundled in the app (use `~/Applications` instead if you installed it there):

```sh
"/Applications/AIO Proxy.app/Contents/MacOS/aio-proxy" service uninstall
```

Then quit the app and move it to the Trash. Your configuration in `~/.aio-proxy` is kept. If you installed the `aiop` command, also remove `/usr/local/bin/aiop`, and `/usr/local/bin/aio-proxy` if it links into the app.

The app writes its own log to `~/Library/Logs/aio-proxy-desktop/aio-proxy-desktop.log`.
