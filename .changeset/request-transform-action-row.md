---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Fit each request transform action on one line and stop leaving a blank space where a remove action would
show a value.

An action used to be a bordered sub-card holding an "Action N" heading and three separately labelled
controls, stacked. A rule with four actions therefore repeated four headings and four borders, and no two
actions lined up. The action select, the target select and the path input now share a single row per action,
with the rule's "Then" connective on the first row and the value editor full-width beneath, so actions read
down a column. Reorder and delete are icon buttons at the end of the row, and they are hidden entirely for a
rule with one action, where reordering and deleting are both impossible — previously they were rendered
disabled.

The path input is now monospace and shows the shape it expects, `temperature` for a body path and
`x-header-name` for a header name — the bare path, which is what the field stores.

A remove action left the value slot empty, which read as a control that had not loaded. It now says that a
remove action needs no value.
