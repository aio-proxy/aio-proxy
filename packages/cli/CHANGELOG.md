# @aio-proxy/cli

## 0.5.2

### Patch Changes

- Updated dependencies [[`39d1b19`](https://github.com/aio-proxy/aio-proxy/commit/39d1b1927055fa483c9d09d82b6e5e76100eee95)]:
  - @aio-proxy/i18n@0.5.2
  - @aio-proxy/core@0.5.2
  - @aio-proxy/dashboard@0.5.2
  - @aio-proxy/server@0.5.2
  - @aio-proxy/logger@0.5.2
  - @aio-proxy/plugin-sdk@0.5.2
  - @aio-proxy/types@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies [[`1a525e8`](https://github.com/aio-proxy/aio-proxy/commit/1a525e861a0ef77668c3321f75171bb9e2880e9f)]:
  - @aio-proxy/core@0.5.1
  - @aio-proxy/server@0.5.1
  - @aio-proxy/dashboard@0.5.1
  - @aio-proxy/i18n@0.5.1
  - @aio-proxy/logger@0.5.1
  - @aio-proxy/plugin-sdk@0.5.1
  - @aio-proxy/types@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [[`7856451`](https://github.com/aio-proxy/aio-proxy/commit/7856451f2434912a619e1c72aca44a1ccd1aaf43), [`c6ecfc0`](https://github.com/aio-proxy/aio-proxy/commit/c6ecfc0dc81e6cb0f0c5cd7b27b79f32cfb0955c), [`d95834a`](https://github.com/aio-proxy/aio-proxy/commit/d95834ad85ea0352f5c389497ea008c687a80d64)]:
  - @aio-proxy/server@0.5.0
  - @aio-proxy/core@0.5.0
  - @aio-proxy/dashboard@0.5.0
  - @aio-proxy/i18n@0.5.0
  - @aio-proxy/logger@0.5.0
  - @aio-proxy/plugin-sdk@0.5.0
  - @aio-proxy/types@0.5.0

## 0.4.0

### Patch Changes

- [#123](https://github.com/aio-proxy/aio-proxy/pull/123) [`d460128`](https://github.com/aio-proxy/aio-proxy/commit/d4601280f29a5322a30b4baa516bc1906d0ea324) Thanks [@baranwang](https://github.com/baranwang)! - cli: fix the managed service becoming unreachable after `brew upgrade`. The service unit now records the stable PATH launcher instead of the version-pinned Cellar binary, `service restart` regenerates an already-installed unit with a freshly resolved executable (recovering units that still point at a deleted old binary), and `resolveExec` falls back to the PATH launcher when the running executable was deleted mid-upgrade. `aio-proxy upgrade` now always restarts a managed daemon after upgrading (the `--restart` flag is removed); a manually started daemon still gets a self-restart hint.
- Updated dependencies [[`2d1d035`](https://github.com/aio-proxy/aio-proxy/commit/2d1d03580db04a8ff957df3b3dd17d0879599282)]:
  - @aio-proxy/i18n@0.4.0
  - @aio-proxy/core@0.4.0
  - @aio-proxy/dashboard@0.4.0
  - @aio-proxy/server@0.4.0
  - @aio-proxy/logger@0.4.0
  - @aio-proxy/plugin-sdk@0.4.0
  - @aio-proxy/types@0.4.0

## 0.3.0

### Minor Changes

- [#117](https://github.com/aio-proxy/aio-proxy/pull/117) [`55d3ccd`](https://github.com/aio-proxy/aio-proxy/commit/55d3ccd49cb6819b8a413050a7a668efc9df17c0) Thanks [@baranwang](https://github.com/baranwang)! - cli: publish a multi-arch (amd64/arm64) Docker image to GHCR on release, and add a Dockerfile and docker-compose example for running aio-proxy in a container

### Patch Changes

- Updated dependencies [[`38960fd`](https://github.com/aio-proxy/aio-proxy/commit/38960fd9fca94d3e38cb5277a5eb928a3962d96a), [`5a6deb7`](https://github.com/aio-proxy/aio-proxy/commit/5a6deb759ed7c748369db2dee814d2686dcd2e8d)]:
  - @aio-proxy/core@0.3.0
  - @aio-proxy/server@0.3.0
  - @aio-proxy/dashboard@0.3.0
  - @aio-proxy/i18n@0.3.0
  - @aio-proxy/logger@0.3.0
  - @aio-proxy/plugin-sdk@0.3.0
  - @aio-proxy/types@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/core@0.2.1
  - @aio-proxy/dashboard@0.2.1
  - @aio-proxy/i18n@0.2.1
  - @aio-proxy/logger@0.2.1
  - @aio-proxy/plugin-sdk@0.2.1
  - @aio-proxy/server@0.2.1
  - @aio-proxy/types@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/core@0.2.0
  - @aio-proxy/dashboard@0.2.0
  - @aio-proxy/i18n@0.2.0
  - @aio-proxy/logger@0.2.0
  - @aio-proxy/plugin-sdk@0.2.0
  - @aio-proxy/server@0.2.0
  - @aio-proxy/types@0.2.0
