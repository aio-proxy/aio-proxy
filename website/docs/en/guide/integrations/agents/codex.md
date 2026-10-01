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

## Model Catalogs and Refresh

Initial setup through the CLI wizard or Dashboard fetches the full model catalog, saves it under the current Codex home's managed directory, and sets `model_catalog_json`. Local Codex uses this full catalog by default, giving third-party models the complete task guidance. Matching official models retain their official instructions and additional messages. Codex home resolution respects `CODEX_HOME`; AIO Proxy manages only this connected home.

The HTTP endpoint `GET /v1/models?client_version=<version>` uses compact task guidance by default to reduce model discovery response size. Use `codex_instructions=compact` explicitly for compact guidance or `codex_instructions=full` to export the full catalog. Compact guidance changes third-party model prompts; equivalent behavior to full guidance is not guaranteed. Official instructions remain intact. Codex limits HTTP catalog responses to 1 MiB, so use a local file for larger full catalogs.

The managed local catalog is checked for updates at four points:

1. After AIO Proxy starts.
2. After a Provider model snapshot is successfully updated, such as a configuration reload or model rediscovery.
3. When an authenticated Codex model catalog request arrives.
4. Every six hours while the service runs.

**Restart Codex CLI or Desktop after a catalog file update.** Codex loads local catalogs only at startup. Background refresh failures preserve the existing catalog. Initial setup does not report success if it cannot fetch or save a valid catalog.

A remote service or Docker container can manage only a Codex home accessible to its process and eligible for local integration. It cannot write a catalog for Codex on another machine or outside the container. Clients can use the compact HTTP catalog in that situation. To use a full local catalog, fetch the file on the client machine and configure its local `model_catalog_json`. HTTP exports do not guarantee capacity for an arbitrary number of models.

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

Removal restores the personal model catalog configuration that existed before setup, if any. If you changed managed fields afterward, AIO Proxy preserves those changes and reports partial removal. Migrated sessions and other personal preferences remain intact.
