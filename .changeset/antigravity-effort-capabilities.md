---
'@aio-proxy/plugin-google-antigravity': patch
'aio-proxy': patch
---

Google Antigravity models now report which reasoning effort levels they actually accept. Asking a Claude-backed Antigravity model for `xhigh`, or a Gemini-backed one for `xhigh`/`max`, used to fail upstream instead of being clamped; those requests are now clamped to the highest level the model supports. `minimal` is only offered on Gemini wires that genuinely support it.
