---
'@aio-proxy/core': patch
'@aio-proxy/dashboard': patch
'@aio-proxy/server': patch
'aio-proxy': patch
---

Keep per-model metadata edits when saving an OAuth provider also re-authorizes it. The editor saves
credentials and model metadata in one action; if the credential half required re-authorization, the
login path rebuilt the provider entry from a patch that had no metadata field, so the metadata half
of the save was silently discarded.
