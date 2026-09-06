---
'aio-proxy': patch
---

docs: publish the curl installer at https://aioproxy.dev/install.sh; it installs the prebuilt binary from the published `@aio-proxy/cli-<os>-<arch>` npm package — the same artifact `aio-proxy upgrade` and the Homebrew tap use — and refuses musl-based Linux, which has no published build, instead of installing a glibc binary that cannot start
