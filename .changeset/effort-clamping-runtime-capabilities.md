---
'aio-proxy': patch
'@aio-proxy/types': patch
'@aio-proxy/core': patch
'@aio-proxy/server': patch
'@aio-proxy/plugin-google-antigravity': patch
---

Reasoning effort now clamps to what the chosen provider actually supports, read from the provider's
own catalog first and models.dev only as a fallback, so plugin-backed models no longer forward a
level the upstream rejects. Google Antigravity's variants, including its split Low/Medium/High
Gemini wires, each advertise their real levels and clamp down instead of failing the request. A
`max` request now reaches a provider that supports `max` instead of arriving as `high`, and an
alias asked for more effort than its highest variant declares routes to that variant instead of
falling back to the alias base.
