---
'aio-proxy': patch
'@aio-proxy/plugin-cursor': patch
---

Models served through the Cursor provider, such as `grok-4.7`, now reliably call the client's function tools. Previously they often tried Cursor's own Shell or Read tools, were told those were unavailable, and then answered in prose instead of returning a tool call.
