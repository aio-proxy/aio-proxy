---
'@aio-proxy/core': patch
'aio-proxy': patch
---

Stop a partial provider update from deleting an OAuth provider's display name, aliases, or model
whitelist. Rebuilding the entry treated an omitted field as "clear it", so any surface that saved
without sending all of them — a re-login, or an edit screen that only owns some — silently dropped
config the user had authored elsewhere. This is the same defect already fixed for per-model metadata,
and the remaining fields now follow that rule: a field a save does not mention keeps its stored value.
`weight` is the deliberate exception, because an omitted key is the only way to say "no weight", and
clearing the display name now removes it instead of storing an empty name.
