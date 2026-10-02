---
'@aio-proxy/plugin-sdk': minor
---

Quota items can declare a `scope` — the whole account, or a list of model patterns — to tell aio-proxy which models are refused once that window is exhausted, so routing can skip the Provider for those models until the window resets. Items without a scope stay display-only.
