---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Make the request-transform value editor easier to read and fill in. Object and array values are no longer
typed into a cramped inline box: the rule shows the value as compact JSON and an Edit JSON button opens a
full-height editor, where Apply stays disabled until what you typed is really a JSON object or array of the
type you picked, and Cancel throws the draft away. Because a broken draft now stays inside that editor, it
can no longer put the whole rule list into an invalid state or lock you out of the JSON tab while you fix
it. Boolean values are chosen from a true/false select instead of a checkbox labelled "True", so setting a
field to false is a direct choice rather than an unticked box. The value type and the value itself now sit
side by side on one row instead of stacking as two labelled rows, which makes rules with several actions
much shorter, and text and number values show an example of what belongs there. The controls are also named
for what they do rather than how they work: the mode reads Fixed value, its input reads Value to set, and
the type select reads Value type.
