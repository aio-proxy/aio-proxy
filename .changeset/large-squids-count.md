---
'aio-proxy': minor
'@aio-proxy/cli': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/i18n': minor
'@aio-proxy/agent-provider-runtime': minor
'@aio-proxy/opencode-provider': minor
'@aio-proxy/pi-provider': minor
'@aio-proxy/plugin-xai-grok': minor
---

Add managed OpenCode, Pi, and oh-my-pi Agent integrations. Configure them with `aio-proxy agent configure` (floors: OpenCode 1.17.10, Pi 0.84.2, oh-my-pi 17.3.7; login with `opencode auth login --provider aio-proxy` or `/login aio-proxy`). `aio-proxy upgrade` refreshes managed adapters; reload or restart the Agent after configure or upgrade. Exact string KPI values no longer lose visible precision. The xAI artifact smoke gate now follows plugin API v2.
