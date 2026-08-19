---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Align the provider editor's models section with the prototype. Manual add is a
plain input plus an Add button that prepends new ids, every row has a checkbox
and a remove control, alias targets are only the enabled models, and removing a
model silently drops aliases (and variants) that pointed at it. OAuth providers
get the same catalog button; it refreshes the saved edit-view catalog instead of
calling the unsupported draft-catalog endpoint.
