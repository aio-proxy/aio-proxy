---
'aio-proxy': patch
'@aio-proxy/plugin-xai-grok': patch
---

Grok OAuth now sends current Grok CLI identity headers and strips Codex Desktop Responses fields that `cli-chat-proxy.grok.com` rejects or hangs on.
