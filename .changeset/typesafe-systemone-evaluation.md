---
'@aio-proxy/core': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'aio-proxy': minor
---

Evaluate with TypeSafe System One. `POST /v1/systemone` takes the System One request format and routes it like any other model request, with priority and weight failover and System One-shaped errors. Usage is recorded on every answered evaluation, so this traffic now bills. Providers declaring the new `typesafe-systemone` protocol, as primary or as an extra endpoint, are served by verbatim passthrough; ones whose AI SDK package exposes an evaluation model are served by conversion. The dashboard offers the protocol for providers and trace filters, and reports newer bundled AI SDK provider versions.
