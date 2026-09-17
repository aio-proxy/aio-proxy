---
'aio-proxy': patch
'@aio-proxy/core': patch
---

Codex Desktop tool results that arrive without a `call_id` are rewritten to a user note on the OpenAI Responses raw path. Outputs that still have a `call_id` are left for stored previous-response state.
