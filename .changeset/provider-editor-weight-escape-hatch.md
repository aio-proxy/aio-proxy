---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Make provider weight editable beyond the slider's reach, and stop the routing screen contradicting
itself about an absent one. The weight slider can only express `0-100` on a step of `5`, so a config
weight of `250` or `7` was displayed but destroyed by the first drag with no way to type it back, and
a weight that had never been set could not be returned to unset. A number input now sits beside the
slider on the same field: it carries no bounds, so any weight config accepts survives being typed and
saved, and clearing it means absent rather than `0`. An absent weight is treated as `0` for ordering,
exactly as the router does, and the field now shows that `0` instead of an empty box.
