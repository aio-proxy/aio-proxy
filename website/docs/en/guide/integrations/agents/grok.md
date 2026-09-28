---
description: Connect xAI Grok Build via aio-proxy agent configure grok with Dashboard device code authorization.
---

# xAI Grok Build Integration

xAI Grok Build is an end-to-end autonomous engineering CLI. AIO Proxy integrates directly via native auth helpers.

## One-Click Configuration

```sh
aio-proxy agent configure grok
```

This command detects `~/.grok` (or `GROK_HOME`), injects the AIO Proxy auth helper, and generates an installation ID.

---

## Authentication & Usage

Run the standard login command:

```sh
grok login
```

1. Select **AIO Proxy** in the login prompt.
2. Confirm the device code in the AIO Proxy Dashboard (`http://127.0.0.1:9317/dashboard/agents/authorize#code=...`).
3. Once approved, list models and start coding:

```sh
grok models
grok -m gpt-5
```

---

## Removal

```sh
aio-proxy agent remove grok
```
