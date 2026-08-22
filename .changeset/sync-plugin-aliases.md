---
'@aio-proxy/types': patch
'@aio-proxy/server': patch
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

The provider editor's Model aliases block now offers a Sync plugin aliases button for OAuth providers
whose plugin ships default aliases. Clicking it merges the plugin's suggestions into the alias list you
are editing: a suggestion overwrites the alias that already carries its name, every other alias you wrote
is kept, and names the draft does not have yet are appended. Nothing is written until you save, so the
merge can be reviewed and undone like any other edit in the form.

Only suggestions this provider can actually route are offered: a suggestion pointing at a model outside
the provider's enabled models is dropped, together with any of its variants, because an alias aimed at a
model the provider does not expose is what blocks Save. The button is absent when the provider's plugin
has no suggestions or none survive that filter, and disabled while no upstream model is enabled. A plugin
that returns a malformed suggestion, or throws while producing them, now costs only the suggestions — the
editor page still opens.
