---
'aio-proxy': patch
'@aio-proxy/cli': patch
'@aio-proxy/dashboard': patch
'@aio-proxy/types': patch
'@aio-proxy/i18n': patch
---

The dashboard no longer offers Repair for a Codex or Grok Build integration whose managed fields you edited. Setup deliberately does not overwrite your edits, so Repair always failed with "Something went wrong". The card now tells you to remove the integration (your edits are kept) and configure it again, and setup that hits edited fields reports exactly that instead of an unknown error.
