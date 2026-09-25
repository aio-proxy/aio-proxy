---
description: Integrate OpenCode AI assistant via dynamic extension injection and catalog negotiation.
---

# OpenCode Integration

OpenCode connects to AIO Proxy via an automated local plugin extension.

## Configuration

```sh
aio-proxy agent configure opencode
```

This detects OpenCode's configuration paths via `opencode debug paths` and injects the AIO Proxy bridge module.

---

## Usage

```sh
opencode auth login --provider aio-proxy
```

Restart OpenCode to see all models aggregated by AIO Proxy.

---

## Removal

```sh
aio-proxy agent remove opencode
```
