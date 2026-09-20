---
'@aio-proxy/core': patch
'aio-proxy': patch
---

Chat Completions streaming now shapes tool-call chunks the way OpenAI does: the first chunk carries the call id and function name, every chunk after it carries only the argument delta. Clients that concatenate the fields they receive no longer end up with duplicated JSON, a repeated call id or tool name, or broken tool calls such as a bash `command` of `{`.
