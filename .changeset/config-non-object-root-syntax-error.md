---
'@aio-proxy/core': patch
'@aio-proxy/server': patch
'aio-proxy': patch
---

Raise a `SyntaxError` when a config file parses to a non-object root, so a Settings write against `[]` or `null` answers `config_rejected` instead of failing with an unhandled server error.
