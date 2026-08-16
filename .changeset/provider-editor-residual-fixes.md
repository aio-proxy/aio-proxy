---
'@aio-proxy/dashboard': patch
'aio-proxy': patch
---

Four provider-editor follow-ups. The save footer no longer softens its lead-in sentence while Save is
still disabled: as soon as one section blocks the save it says so, instead of only saying so when
_every_ listed section blocks. The providers list prints a dash for a provider that has no configured
weight rather than `0`, so it agrees with the editor and with the attempt-order queue — and a
deliberate `0`, which is a real lowest-priority weight, is no longer indistinguishable from an unset
one. Clearing a provider's display name and saving now removes the key instead of writing an empty
`name` into the config file, matching what an OAuth provider already did. And the weight slider's
thumb stays on its track for a stored weight beyond `0-100`; the number input beside it still shows
and keeps the real value.
