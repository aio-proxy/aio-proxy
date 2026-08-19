---
'@aio-proxy/dashboard': patch
'aio-proxy': patch
---

Fix three provider-editor model regressions. Per-model metadata is now reconciled against what was
actually persisted, so creating a provider no longer writes an empty `{}` record for a model whose
cost fields were cleared, while an edit that clears them still sends the explicit empty object the
API needs to overwrite the stored one. A cost or context number whose text cannot round-trip is
refused rather than displayed. And the manual-add box is the shared tags control again: it splits the
`gpt-5-mini, gpt-5` list its placeholder promises on commas and newlines instead of committing a
half-typed id at the first comma.
