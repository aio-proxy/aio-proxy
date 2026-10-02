---
'aio-proxy': minor
'@aio-proxy/cli': minor
'@aio-proxy/server': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/types': minor
'@aio-proxy/i18n': minor
---

`aiop agent configure claude-code` points Claude Code at aio-proxy by merging `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` into the global `~/.claude/settings.json`, leaving every other setting in place. Without proxy API keys it writes a placeholder token so Claude Code stops using its claude.ai login; with keys you choose one, in the terminal or on the Dashboard's Agents page. `agent list` shows the integration, and `agent remove claude-code` restores only those two keys.
