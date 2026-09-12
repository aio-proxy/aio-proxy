---
'aio-proxy': minor
'@aio-proxy/cli': minor
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/agent-provider-runtime': minor
---

Add interactive Codex setup with a customizable Provider ID and a choice to keep ChatGPT login via an existing proxy API key or use command authentication. Command auth reuses a still-valid helper token, refreshes after a 401 probe, accepts a version-only --version launcher, and rejects static-key redirects. A drifted keep-ChatGPT config is rejected before command authorization; recovery can finish a Provider ID rename. Removal respects user edits, revokes from the marker’s applied endpoint when local auth files are gone, and blocks when the config cannot be restored. `aiop agent list` reports a conflicted Codex inspect instead of aborting other integrations, and a malformed config journal cannot delete the ownership marker.
