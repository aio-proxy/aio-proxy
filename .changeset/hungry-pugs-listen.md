---
'@aio-proxy/cli': patch
'aio-proxy': patch
---

Fixed `aio-proxy upgrade --version` on prerelease versions. The post-install check dropped the prerelease suffix when reading the new binary's version, so it compared `0.23.1` against the requested `0.23.1-canary.…`, judged the install a failure, and rolled the working binary back.
