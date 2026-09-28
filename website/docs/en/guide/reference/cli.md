---
description: Complete CLI command reference for aio-proxy (server, config, oauth, agent, service, upgrade).
---

# CLI Reference

The `aio-proxy` command-line interface provides comprehensive controls for running, configuring, and maintaining the proxy.

:::tip Alias
The shortcut command `aiop` is identical to `aio-proxy`.
:::

---

## Command Overview

| Command   | Description                                                     |
| :-------- | :-------------------------------------------------------------- |
| `run`     | Start the HTTP proxy server and Dashboard                       |
| `config`  | Manage, edit, validate, and print configuration                 |
| `reload`  | Send a hot-reload signal to the running daemon                  |
| `oauth`   | Log in and manage OAuth subscription accounts                   |
| `agent`   | Configure native coding agents (Codex, Grok, OpenCode, Pi, OMP) |
| `service` | Manage background OS daemons (launchd / systemd)                |
| `upgrade` | Self-upgrade CLI binary to the latest release                   |

---

## Command Reference

### `aio-proxy run`

```sh
aio-proxy run [options]
```

- `--open`: Open Dashboard in default browser upon startup.
- `--port <number>`: Override port (default `9317`).
- `--host <ip>`: Bind address (default `127.0.0.1`; use `0.0.0.0` for Docker).
- `--config <path>`: Custom configuration file path.

### `aio-proxy config`

```sh
aio-proxy config edit       # Open config in default editor
aio-proxy config validate   # Check syntax and schema
aio-proxy config print      # Print active configuration
aio-proxy reload            # Hot-reload running server
```

### `aio-proxy oauth`

```sh
aio-proxy oauth login <provider-id>   # Launch browser login
aio-proxy oauth status                # Inspect token validity
```

### `aio-proxy agent`

```sh
aio-proxy agent configure <codex|grok|opencode|pi|omp>
aio-proxy agent list [--check]
aio-proxy agent remove <target>
aio-proxy agent revoke <installation-id>
```

### `aio-proxy service`

```sh
aio-proxy service install     # Register system daemon
aio-proxy service start       # Start background daemon
aio-proxy service status      # View daemon status
aio-proxy service stop        # Stop background daemon
aio-proxy service uninstall   # Unregister system daemon
```
