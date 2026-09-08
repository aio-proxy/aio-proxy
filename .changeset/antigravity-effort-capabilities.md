---
'@aio-proxy/plugin-google-antigravity': patch
'aio-proxy': patch
---

Google Antigravity Gemini requests no longer fail when the variant handling them does not accept the reasoning effort you asked for. Requesting `minimal` on a variant with no minimal tier, or asking one of the split Low/Medium/High variants for an effort that belongs to a sibling, used to be rejected with an error. Each variant now reports the levels it really accepts, so such a request is quietly clamped down to the nearest supported level instead.
