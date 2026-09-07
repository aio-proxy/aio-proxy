---
'aio-proxy': patch
'@aio-proxy/cli': patch
---

`aio-proxy upgrade` reports and hands off the Homebrew-installed version when the tap bottle is behind npm `latest`, so Agent post-upgrade does not skip a successful install.
