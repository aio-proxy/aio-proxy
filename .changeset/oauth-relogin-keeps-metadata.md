---
'@aio-proxy/core': patch
'aio-proxy': patch
---

Keep per-model metadata when an OAuth provider is re-authorized. Every re-login rebuilt the provider
entry from a fixed field list that omitted `metadata`, so re-authorizing from the Dashboard or running
`provider login` again deleted all per-model overrides — including `extend`, which is how a model
tracks its models.dev source.
