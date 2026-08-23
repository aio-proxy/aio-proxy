---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Align the request-transform editor shell with the demo: one dotted path
input, usable structure buttons on an invalid rule, and JSON-mode copy
for unsupported or non-array drafts.

Empty path values no longer encode as a whole-body replacement. Existing
`$set: { 'request.body': … }` configs stay byte-identical and open in the
JSON tab.
