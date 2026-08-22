---
'@aio-proxy/dashboard': patch
'aio-proxy': patch
---

Four provider-editor follow-ups. The save footer's lead-in now describes the list it introduces: it
promises a missing field only when every listed section is empty, and reads "Pending" when one of them
merely needs authorizing. The providers list prints a dash for a provider that has no configured
weight rather than `0`, so a deliberate `0`, which is a real lowest-priority weight, is no longer
indistinguishable from an unset one. Clearing a provider's display name and saving now removes the key
instead of writing an empty `name` into the config file, matching what an OAuth provider already did. And
the weight slider's thumb stays on its track for a stored weight beyond `0-100`; the number input beside it
still shows and keeps the real value.
