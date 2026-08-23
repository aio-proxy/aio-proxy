---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Align the provider editor's right rail with the prototype. The model-test controls
disappear when nothing is testable instead of leaving a disabled full-width button,
the visible "Model to test" label becomes an accessible name only, and a pending
test keeps the same button copy with a spinner instead of swapping in a second
string. The exposure panel title is "Model list", its empty state says which names
will appear, and a disabled provider folds that reason into the same sentence.
