---
'@aio-proxy/core': patch
'@aio-proxy/ui': patch
'aio-proxy': patch
---

Three provider-editor follow-ups. A display name that is only whitespace now clears the key on an OAuth
provider instead of being written into the config file: the empty string was already dropped, but `"   "`
survived, and since the editor treats a blank-after-trim name as absent, the config kept a `name` nothing
would ever render. The dashboard's own form normalizer already trimmed, so this only affected OAuth
providers. Rejecting a staged OAuth write now throws a real `Error`, so the structured logs that record an
error's name during config recovery and session-store writes report `ZodError` rather than `Error` or
`object`; the rejection message and its `providers.<id>.<field>` issue paths are unchanged. And the shared
combobox primitive now requires an accessible name for its clear button at the type level, so a caller
cannot enable the button and leave it unnamed — both existing callers already pass one, so nothing changes
on screen.
