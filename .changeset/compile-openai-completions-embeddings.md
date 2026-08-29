---
'aio-proxy': patch
'@aio-proxy/core': patch
---

Compile the OpenAI Completions, Embeddings, and Legacy Completions request schemas so inbound parse uses Zod's fast path.
