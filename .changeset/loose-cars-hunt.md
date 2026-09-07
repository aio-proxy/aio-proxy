---
'aio-proxy': patch
'@aio-proxy/plugin-cursor': patch
---

Fix Cursor OAuth requests hanging on interaction or stream completion, losing tool arguments or sibling calls, and repeating tools because resumed context omitted their calls and results. Stalled runs now terminate with clearer diagnostics.
