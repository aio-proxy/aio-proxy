---
description: Register AIO Proxy as a native background daemon (macOS launchd / Linux systemd) that starts on boot and auto-restarts on crashes.
---

# Background Service (`service`)

For ongoing development, running AIO Proxy in an active terminal window is inconvenient. AIO Proxy provides native `service` commands to manage background daemons across macOS and Linux without manual service unit configuration.

---

## Quick Service Management

```sh
# 1. Install and register background service (auto-starts on boot)
aio-proxy service install

# 2. Start the service
aio-proxy service start

# 3. Check service status
aio-proxy service status

# 4. Stop the service
aio-proxy service stop

# 5. Uninstall and unregister the service
aio-proxy service uninstall
```

---

## Platform Implementations

### macOS (`launchd`)

On macOS, `aio-proxy service install` registers a user-level LaunchAgent plist file at:
`~/Library/LaunchAgents/dev.aioproxy.aio-proxy.plist`

- **Permissions**: Runs entirely within user session permissions without requiring `sudo`.
- **Logging**: Standard output and error logs are automatically piped to `~/.aio-proxy/logs/service.log`.
- **Auto-restart**: If the process terminates abnormally, launchd automatically relaunches it.

### Linux (`systemd`)

On Linux, it creates a systemd user unit at:
`~/.config/systemd/user/aio-proxy.service`

You can also inspect it directly with standard systemctl tools:

```sh
systemctl --user status aio-proxy
journalctl --user -u aio-proxy -f
```

---

## Hot Configuration Reloading

When AIO Proxy runs as a background daemon, you do not need to restart the service after modifying `config.jsonc`. Simply execute:

```sh
aio-proxy reload
```

This sends an in-process reload signal to the running daemon, reloading providers, routes, and credentials seamlessly with zero request downtime.
