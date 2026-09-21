---
'@aio-proxy/types': minor
'@aio-proxy/agent-provider-runtime': minor
'@aio-proxy/pi-provider': minor
'@aio-proxy/cli': minor
'@aio-proxy/i18n': minor
'aio-proxy': minor
---

`aio-proxy agent configure` now accepts `--protocol chat-completions|responses|anthropic`. Pi and OMP persist that choice in a local sidecar and talk to aio-proxy on the matching inbound API; `agent list` shows it. OpenCode, Grok, and Codex still keep their current protocols and reject unsupported values.
