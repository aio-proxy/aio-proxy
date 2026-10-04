---
'aio-proxy': patch
'@aio-proxy/core': patch
'@aio-proxy/server': patch
'@aio-proxy/plugin-openai-chatgpt': patch
'@aio-proxy/types': patch
---

Allow large image histories and compressed recovery requests with a configurable 256 MiB request limit, including ChatGPT and Provider body transforms. Bound body logs independently to 64 MiB per hop and direction while preserving full forwarding, request diagnostics, and privacy protections.
