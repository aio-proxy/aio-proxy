---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Align the request-transform condition builder and value editor with the demo:
computed values show a live expression preview, the expression tree gets its
indent, argument markers and connector lines, and condition groups and rows
get their own cards instead of a fixed 768px block.

Function names now read from one source (`+`, `CONCAT`, `IF NULL`) instead of
a separate set of translations, condition rows drop the move buttons,
`provider.*` is offered only inside computed values, and every value control
announces the rule it belongs to. The expression tree's argument markers are
localized too, so they no longer read as Chinese in the other four locales.
