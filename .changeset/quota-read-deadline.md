---
'@aio-proxy/server': patch
'@aio-proxy/core': patch
'aio-proxy': patch
---

Enforce the OAuth quota read deadline in the host instead of trusting the plugin

The abort signal handed to a plugin's `quota.read` was advisory: a plugin that never checked it left
the read pending forever, and because the snapshot lease is released in a `finally` attached to that
same promise, the retired config snapshot could never drain. The host now races the read against the
signal, and a caller-initiated cancellation surfaces as the abort reason rather than being logged and
reported as a plugin failure.
