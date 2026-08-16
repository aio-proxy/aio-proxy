---
'@aio-proxy/dashboard': patch
'aio-proxy': patch
---

Make provider weight editable beyond the slider's reach, and stop the routing screen contradicting
itself about an absent one. The weight slider can only express `0-100` on a step of `5`, so a config
weight of `250` or `7` was displayed but destroyed by the first drag with no way to type it back, and
a weight that had never been set could not be returned to unset. A number input now sits beside the
slider on the same field: it carries no bounds, so any weight config accepts survives being typed and
saved, and clearing it means absent rather than `0`. The attempt-order queue no longer prints `0` for
a provider that has no configured weight — it prints a dash, matching what the field itself says,
while provider ordering keeps treating absent as `0` exactly as the router does. The queue's per-alias
lists are now named after their alias for screen readers, and its title is a heading instead of a
label pointing at no control.
