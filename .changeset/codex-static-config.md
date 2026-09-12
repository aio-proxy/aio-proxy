---
'aio-proxy': minor
'@aio-proxy/cli': minor
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/agent-provider-runtime': minor
---

Add interactive Codex setup with a customizable Provider ID and a choice to retain ChatGPT login features using an existing proxy API Key, or use command authentication with AIO Proxy device authorization. Command authentication accepts the installed aiop or aio-proxy launcher when --version prints only the version number. Setup preserves model settings and supports optional legacy history migration; recovery can finish a command-mode Provider ID rename after a crash. Removal respects user edits and revokes command credentials, but blocks when the config cannot be safely restored.
