---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Let the provider Routing section type any weight or priority. Clearing a field means absent, which the
router treats as weight `1` and priority `0`. The editor shows an empty box for an absent value so it
is distinguishable from an authored `0`.
