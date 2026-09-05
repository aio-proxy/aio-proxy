---
'@aio-proxy/core': patch
'aio-proxy': patch
---

Strip orphan reasoning item ids from OpenAI Responses raw requests.

A turn served through the AI SDK model path leaves the proxy's own synthetic
`rs_…` id on the reasoning item, and the client replays that id in the next
turn's `input`. With `store: false` — which the ChatGPT Codex backend forces —
the upstream never persisted it, so the lookup failed with "Item with id 'rs_…'
not found. Items are not persisted when store is set to false." Reasoning items
that cannot replay by `encrypted_content` now forward without the id and are
re-sent as new content; the summary is kept. The `invalid_encrypted_content`
retry drops the id alongside the unusable blob for the same reason. Requests
that opt into `store: true` are untouched.
