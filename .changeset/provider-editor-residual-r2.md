---
'@aio-proxy/core': patch
'aio-proxy': patch
---

A display name that is only whitespace now clears the key on an OAuth provider instead of being written
into the config file. The empty string was already dropped, but `"   "` survived on both the ordinary
save path and reauthorization; the editor already treats a blank-after-trim name as absent, so the
config kept a `name` nothing would ever render. Rejecting a staged OAuth write now throws a real
`Error`, so the structured logs that record an error's name during config recovery and session-store
writes report `ZodError` rather than `Error` or `object`; the rejection message and its
`providers.<id>.<field>` issue paths are unchanged.
