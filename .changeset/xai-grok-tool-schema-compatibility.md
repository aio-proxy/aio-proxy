---
'@aio-proxy/plugin-xai-grok': patch
'aio-proxy': patch
---

Preserve Codex function-tool schemas on xAI Grok OAuth requests by resolving local references and explicit object unions, while isolating only tools whose schemas cannot be converted safely.
