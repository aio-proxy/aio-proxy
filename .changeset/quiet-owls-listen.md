---
'@aio-proxy/dashboard': patch
'@aio-proxy/server': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Stop the Dashboard provider editor from deleting a hand-written `endpoints` list. Saving a provider from the editor used to drop its multi-protocol `endpoints` — the mutation body schema strips the field, so every save read as "the author deleted it" — and still answer 200. The list is now retained across a save, like `headers`, `metadata`, `proxy`, and `transforms` already were.

Opening a provider that declares `endpoints` with no top-level `protocol`/`baseURL` pair now explains that the editor cannot represent it yet and points at `config.jsonc`, instead of claiming the provider does not exist.

Also in the editor: provider sections render as cards, and the identity section says up front that the ID is fixed once saved.
