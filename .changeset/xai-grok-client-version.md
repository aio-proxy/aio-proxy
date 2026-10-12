---
'aio-proxy': patch
'@aio-proxy/plugin-xai-grok': patch
---

Fix xAI Grok OAuth requests being rejected with `426 Upgrade Required`. The provider now identifies as the current Grok Build client, so `grok-4.7` requests no longer fail over to another provider of the same model, where client tool calls could come back as "Tool not available" text instead of real function calls.
