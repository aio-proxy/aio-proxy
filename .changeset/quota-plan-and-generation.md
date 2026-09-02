---
'@aio-proxy/plugin-kimi-code': patch
'@aio-proxy/plugin-xai-grok': patch
'@aio-proxy/server': patch
'aio-proxy': patch
---

Harden two edges of the OAuth quota read

A plan name with surrounding whitespace is rejected by `LocalizedTextSchema`, so a padded Kimi
membership level or xAI subscription tier turned an optional enrichment into failure of the whole
otherwise-valid snapshot; both are now trimmed. And a quota read still in flight when its Provider is
reconfigured is retried against the new configuration rather than resolving the caller with the
retired account's snapshot, which the dashboard would have cached and rendered under the new one.
