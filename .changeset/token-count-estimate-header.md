---
'@aio-proxy/server': patch
'aio-proxy': patch
---

Bring back the `x-aio-proxy-token-count-estimated: true` response header on a `count_tokens` answered by the local estimator. The previous release moved that signal into the trace, but a trace is not reachable by an API caller, so an estimate arrived looking exactly like an exact upstream count. The trace span stays; an exact upstream count still carries no header.
