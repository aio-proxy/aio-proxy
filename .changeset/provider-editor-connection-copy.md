---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Fix what the provider editor tells you about its own identity and connection. The Provider ID field no
longer disappears while creating an OAuth provider: it stays in place, empty and disabled, saying the
authorization flow fills it in, so the fields beside it stop sliding across the card when the kind
changes. The identity section states up front that the ID cannot change after saving, instead of hiding
that under the field and repeating it twice, and the kind tiles head with the bare product names.

The API Key field described itself by edit mode, so editing a provider that has no stored key still
promised to "keep the stored key", and a create seeded from an existing entry claimed the field was
empty when it was not. It now describes whether a key is actually stored, and says so with the copy the
rest of the form uses: a key is optional for most upstreams, required for Anthropic's Bearer
authentication.

The protocol dropdown opens on OpenAI Compatible, which is what most third-party gateways speak, rather
than on whichever protocol happened to be declared first. The AI SDK package field's placeholder is an
example again — it used to be the bundled package name verbatim, so a cleared field looked like it was
already filled with it, and saving that emptiness failed validation instead.

Editing an OAuth provider now confirms the account it is connected to, announced to screen readers, in
place of a read-only table that printed the account name a second time and said nothing about being
connected. Its reauthorize button sits beside the copy that explains it, at the same size as the
authorize button on the create screen.
