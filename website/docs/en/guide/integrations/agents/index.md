---
description: Learn about native Agent integrations in AIO Proxy (aio-proxy agent) for zero-config bridge and credential delegation.
---

# Native Agents Overview

Modern AI coding agents (such as OpenAI Codex, xAI Grok Build, OpenCode, Pi, and OMP) run as local CLIs or desktop applications, each with distinct configuration layouts, session stores, and authentication models.

Manually wiring these tools to a local proxy usually requires copying Base URLs, editing nested configuration files, and repeating the process after tool upgrades. AIO Proxy solves this with the native `aio-proxy agent` command suite:

- **Automated Detection**: Discovers installed agents, host versions, and active profile directories.
- **Zero-Copy Credential Bridge**: Generates and rotates dedicated local agent tokens automatically, with Dashboard device-code approval.
- **Non-destructive Migration**: Safely maintains proxy configuration blocks, supports session migration with rollback journals, and leaves user preferences untouched upon removal.

---

## Supported Agents

| Agent Key  | Target Tool                | Integration Mechanism                                     | Guide                                       |
| :--------- | :------------------------- | :-------------------------------------------------------- | :------------------------------------------ |
| `codex`    | OpenAI Codex CLI / Desktop | Interactive wizard, provider injection, session migration | [Codex Integration Guide](./codex.md)       |
| `grok`     | xAI Grok Build             | Native Auth Helper injection, Dashboard device code flow  | [Grok Integration Guide](./grok.md)         |
| `opencode` | OpenCode                   | Dynamic plugin detection and model catalog negotiation    | [OpenCode Integration Guide](./opencode.md) |
| `pi`       | Pi Coding Agent            | Extension directory bridge injection                      | [Pi & OMP Integration Guide](./pi-omp.md)   |
| `omp`      | Oh-My-Pi (OMP)             | Profile detection and extension injection                 | [Pi & OMP Integration Guide](./pi-omp.md)   |

---

## Lifecycle Commands

### 1. Inspect Status

```sh
aio-proxy agent list
aio-proxy agent list --check
```

### 2. Disconnect Agent

```sh
aio-proxy agent remove <codex|grok|opencode|pi|omp>
```

### 3. Revoke Authorization

```sh
aio-proxy agent revoke <installation-id>
```
