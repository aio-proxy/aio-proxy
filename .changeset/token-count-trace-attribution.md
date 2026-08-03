---
'@aio-proxy/server': minor
'aio-proxy': minor
---

Make `count_tokens` traces distinguish upstream counts from the local estimate

Previously a `count_tokens` request answered by the local estimator was only
signalled by an `x-aio-proxy-token-count-estimated: true` response header, and
candidates that were passed over before their count capability ran (no token
count capability, unsupported image input, or a missing provider tool) left no
span at all. A trace answered without any upstream count was therefore
indistinguishable from an upstream success.

The response header is removed. The local-estimate fallback now records an
`aio_proxy.token_count` span tagged `aio_proxy.token_count.source=local_estimate`,
and each passed-over candidate records an `aio_proxy.token_count.candidate_skipped`
span carrying the provider id and a skip reason (`no_capability`,
`image_unsupported`, or `missing_tool`). The observability signal moves from the
client response into the trace, where the whole candidate loop is now visible.
