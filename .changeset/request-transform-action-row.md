---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Fit each request transform action on one line and stop leaving a blank space where a remove action would
show a value.

An action used to be a bordered sub-card holding an "Action N" heading and three separately labelled
controls, stacked. A rule with four actions therefore repeated four headings and four borders, and no two
actions lined up. The action select and a single dotted path input now share one row per action,
with the rule's "Then" connective on the first row and the value editor full-width beneath, so actions read
down a column. Reorder and delete are icon buttons at the end of the row, and they are hidden entirely for a
rule with one action, where reordering and deleting are both impossible — previously they were rendered
disabled.

The path input is monospace and takes the full dotted path, `request.body.temperature` or
`request.headers.x-header-name`; the prefix picks the target and the remainder is what the field stores.

A remove action left the value slot empty, which read as a control that had not loaded. It now says that a
remove action needs no value.
