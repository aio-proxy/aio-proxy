---
'aio-proxy': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'@aio-proxy/dashboard': minor
---

Add the OpenAI Decisions API for predicate, choice, and score evaluations. Same-protocol requests pass through, including inline and HTTP(S) images; other evaluation providers share SystemOne routing, fallback, and conversion. Usage includes cache pricing, converted responses always include the full usage object, and evaluations that cannot be converted are still billed. Plugins can recognize the new Decisions protocol.
