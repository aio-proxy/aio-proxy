---
'aio-proxy': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/plugin-openai-chatgpt': minor
'@aio-proxy/plugin-claude-code': minor
'@aio-proxy/plugin-google-antigravity': minor
'@aio-proxy/plugin-xai-grok': minor
'@aio-proxy/plugin-openrouter': minor
---

Trace timelines now use stable start ordering, standard HTTP and GenAI semantics, redacted upstream URLs, and accurate provider, failover, TTFT, and usage attribution. OAuth runtimes can explicitly declare their GenAI provider identity; raw transports can declare upstream URL templates, while converted calls omit templates unless authoritative transport metadata is available.
