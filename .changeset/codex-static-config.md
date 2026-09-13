---
'aio-proxy': minor
'@aio-proxy/cli': minor
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/agent-provider-runtime': minor
---

Add interactive Codex setup with a customizable Provider ID and a choice to keep ChatGPT login via an existing proxy API key or use command authentication. Command authentication uses AIO Proxy device authorization and reuses a still-valid helper token. Setup preserves model settings and can migrate legacy history; removal respects user edits, revokes command credentials, and blocks when the config cannot be restored.
