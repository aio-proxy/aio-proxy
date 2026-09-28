---
description: Use aio-proxy agent configure codex for interactive setup with session migration and zero-copy credential bridging.
---

# OpenAI Codex Integration

OpenAI Codex delivers powerful code generation and collaborative intelligence. AIO Proxy provides an automated configuration wizard for Codex that sets up the provider and migrates existing sessions seamlessly.

## One-Click Configuration

Ensure AIO Proxy is running, then run:

```sh
aio-proxy agent configure codex
```

### Wizard Steps

1. **Provider ID**: Defaults to `aio-proxy`.
2. **Auth Mode**:
   - `keep-chatgpt`: Retains official ChatGPT login while routing custom provider requests through AIO Proxy.
   - `command`: Uses AIO Proxy local Auth Helper for dynamic credential issuance.
3. **API Key**: Select an existing key or delegate to local control plane management.
4. **Session Migration**: Automatically scans active and archived sessions from previous providers and migrates them to AIO Proxy.

---

## Session Migration & Rollback

Every migration operation records an atomic journal. To roll back a migration:

```sh
aio-proxy agent configure codex --restore-migration <operation-id>
```

---

## Status & Removal

```sh
# Inspect connection and configuration
aio-proxy agent list

# Remove AIO Proxy provider configuration from Codex
aio-proxy agent remove codex
```
