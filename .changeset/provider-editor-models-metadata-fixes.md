---
'@aio-proxy/dashboard': patch
'aio-proxy': patch
---

Fix three provider-editor model regressions. Per-model metadata is now reconciled against what was
actually persisted, so creating a provider no longer writes an empty `{}` record for a model whose
cost fields were cleared, while an edit that clears them still sends the explicit empty object the
API needs to overwrite the stored one. A cost or context number whose text cannot round-trip is
refused rather than displayed. And the manual-add box splits a comma- or newline-separated list into
one id per row instead of committing the whole string as a single model id.
