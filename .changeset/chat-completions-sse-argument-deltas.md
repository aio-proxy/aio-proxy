---
'@aio-proxy/core': patch
'aio-proxy': patch
---

Chat Completions streaming now emits incremental `function.arguments` deltas. Clients that concatenate those chunks no longer receive duplicated JSON or broken tool calls such as a bash `command` of `{`.
