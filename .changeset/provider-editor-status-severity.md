---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Make the provider editor's section dots agree with its Save button, and fix the section hints. A section
missing a required field is red, one waiting on an authorization round trip is amber, a finished one stays
primary — and any section that is not finished blocks Save. Hint counts also read "1 model" rather than
"1 models", and an OAuth provider whose empty whitelist exposes its whole upstream catalog now says so
instead of "0 models".
