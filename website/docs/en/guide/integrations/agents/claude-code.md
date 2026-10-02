---
description: Connect Anthropic Claude Code via aio-proxy agent configure claude-code, which merges the proxy endpoint and a token into the global settings.json.
---

# Anthropic Claude Code Integration

Claude Code reads its endpoint and credential from the `env` block of its global `settings.json`. AIO Proxy writes the two keys it needs there and leaves the rest of the file alone.

## One-Click Configuration

```sh
aio-proxy agent configure claude-code
```

This command merges two keys into `~/.claude/settings.json` (or the directory set by `CLAUDE_CONFIG_DIR`):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:9317",
    "ANTHROPIC_AUTH_TOKEN": "aio-proxy-local"
  }
}
```

Restart Claude Code afterwards. Your other settings and `env` entries are not changed, and project-level `.claude/settings.json` files are never touched.

---

## Which Token Is Written

A base URL alone is not enough: without a credential variable, Claude Code keeps using its saved claude.ai login. The token depends on the proxy's `server.apiKeys`:

- **No API keys (default)**: the non-secret placeholder `aio-proxy-local` is written. Nothing is asked.
- **API keys configured**: you choose one of the existing keys, in the terminal or on the Dashboard's **Agents** page. It is checked against the proxy and then written as plain text, and `settings.json` is restricted to your user (mode `0600`); keep it out of shared dotfiles. AIO Proxy never picks a key for you, and a non-interactive run fails without writing anything.

:::tip
If you rotate or delete the chosen key, run `aio-proxy agent configure claude-code` again to pick a new one.
:::

---

## Inspect and Remove

```sh
aio-proxy agent list --check
```

Claude Code is shown as `managed`, or as `modified` with the fields you edited yourself. `--check` also probes the proxy with the configured token.

```sh
aio-proxy agent remove claude-code
```

Removal works offline. The two keys go back to what they were before configure; a key you edited afterwards is kept and reported. Proxy API keys are not deleted.

AIO Proxy records what it wrote in `~/.claude/.aio-proxy/claude-code-config.json`, outside the file Claude Code rewrites, so the integration stays recognisable after you change a `/config` option. If you edited a managed key, `configure` refuses to overwrite it; run `remove` first.
