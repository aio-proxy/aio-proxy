---
'@aio-proxy/core': patch
'aio-proxy': patch
---

Accept OpenAI Responses tool outputs that carry no `call_id`. Codex Desktop's cross-thread delegation injects a synthetic `function_call_output` identified by `name`/`namespace` instead of a `call_id`, which previously failed inbound validation with a 400 even when the request was routed to a same-protocol provider that would have received the body verbatim. Same-protocol raw passthrough now forwards these items untouched and lets the upstream decide; cross-protocol conversion still rejects them, since there is no tool call to pair the output with.
