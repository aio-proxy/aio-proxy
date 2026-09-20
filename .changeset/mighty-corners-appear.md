---
'aio-proxy': patch
'@aio-proxy/pi-provider': patch
---

Route Pi-family gpt-, claude-, and gemini- models through their native Responses, Anthropic, and Gemini APIs while preserving OpenAI Completions as the fallback. GPT sessions now forward stable cache and affinity identifiers to aio-proxy. Pi and OMP display the provider as AIO Proxy.
