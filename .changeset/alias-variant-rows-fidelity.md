---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Align the provider editor's conditional variant rows with the prototype. Rows
stay in the order they are stored instead of being reordered by condition
specificity, so a row no longer jumps up the list the moment its condition is
made more specific. Rows keep their identity across a removal, so DOM focus and
an open condition dropdown stay with the row they belong to rather than moving to
whichever row shifted into that position. A blank `effort` now reports the same
"needs at least one condition" issue as an empty condition, replacing a third
message that told the user to leave a value unset when it already was. The
variant target dropdown drops a stray group wrapper, and the variant copy matches
the prototype: the preserve switch names the variant, both condition errors are
reworded, the variant target select now says which select it is instead of
carrying the same label as the alias-level target select next to it, and the three
condition controls name the alias they belong to instead of repeating one generic
label per row.
