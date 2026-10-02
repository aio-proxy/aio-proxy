---
'aio-proxy': patch
'@aio-proxy/server': patch
'@aio-proxy/core': patch
'@aio-proxy/plugin-sdk': patch
'@aio-proxy/shared': patch
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
---

Preserve transport timings, retry failure reasons, and response attribution for each upstream HTTP send. Trace details now show send counts and indices, so retries with multiple responses no longer appear to be missing timing data.
