---
'@aio-proxy/plugin-google-antigravity': patch
'aio-proxy': patch
---

Google Antigravity models now report which reasoning effort levels each wire actually accepts, so unsupported levels are clamped instead of failing. Asking a Gemini-backed model for `minimal` when that model has no minimal tier, or asking one of the split Low/Medium/High Gemini variants for an effort that belongs to a sibling variant, used to be rejected with an error; both now fall back to a level the model supports. `/v1/models` also lists only the levels each model really offers.
