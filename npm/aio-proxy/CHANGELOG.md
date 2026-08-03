# aio-proxy

## 0.5.2

### Patch Changes

- [#133](https://github.com/aio-proxy/aio-proxy/pull/133) [`39d1b19`](https://github.com/aio-proxy/aio-proxy/commit/39d1b1927055fa483c9d09d82b6e5e76100eee95) Thanks [@baranwang](https://github.com/baranwang)! - Fix Docker release build failure by building `@aio-proxy/i18n` with rslib

  The `@aio-proxy/i18n` package built its declarations with `tsc -b`, unlike every other referenced workspace package (which use rslib). Because `paraglide-js compile` regenerates `src/paraglide/**` on every build, fresh/concurrent builds (such as the multi-arch Docker release) could see i18n's emitted `dist` as stale relative to its regenerated sources, so `@aio-proxy/core`'s declaration generation failed the composite project-reference check with `TS6305: Output file '.../i18n/dist/index.d.ts' has not been built from source file '.../i18n/src/index.ts'`.

  i18n now compiles messages and then builds with rslib like the other packages, emitting its declarations through the same pipeline and eliminating the fragile cross-package staleness check.

## 0.5.1

### Patch Changes

- [#131](https://github.com/aio-proxy/aio-proxy/pull/131) [`1a525e8`](https://github.com/aio-proxy/aio-proxy/commit/1a525e861a0ef77668c3321f75171bb9e2880e9f) Thanks [@baranwang](https://github.com/baranwang)! - core: fix proxied streaming passthrough dropping the request body. Bun 1.3.x
  silently discards a `ReadableStream` request body when `fetch` uses a proxy, so
  `api` providers with a `proxy` configured hung until timeout on streaming
  requests (e.g. `openai-response` passthrough). `createProxyFetch` now buffers a
  streamed request body to bytes before sending it through the proxy, so the body
  survives without changing the streaming response. This lets the build toolchain
  stay on the reproducible Bun 1.3.14 release.

## 0.5.0

### Minor Changes

- [#125](https://github.com/aio-proxy/aio-proxy/pull/125) [`7856451`](https://github.com/aio-proxy/aio-proxy/commit/7856451f2434912a619e1c72aca44a1ccd1aaf43) Thanks [@baranwang](https://github.com/baranwang)! - server: return real upstream token counts for `/v1/messages/count_tokens` when a same-protocol raw provider is configured, and replace the `bytes/64` fallback with a character-class-weighted estimator

- [#129](https://github.com/aio-proxy/aio-proxy/pull/129) [`c6ecfc0`](https://github.com/aio-proxy/aio-proxy/commit/c6ecfc0dc81e6cb0f0c5cd7b27b79f32cfb0955c) Thanks [@baranwang](https://github.com/baranwang)! - normalize and downgrade reasoning effort per upstream model capability

  Inbound reasoning-effort values are now accepted leniently and clamped to what
  each candidate upstream model actually advertises, on both the raw-passthrough
  and AI SDK model-invocation paths. This fixes a `400 ... at output_config.effort`
  error when Claude Code's ultracode mode sent effort `xhigh` to an upstream that
  only supports `low`/`medium`/`high` — the request now downgrades to the highest
  supported level instead of being rejected. Capability resolution is cache-only,
  so a cold or slow models.dev never blocks the request (it falls back to
  forwarding the client's value unchanged).

### Patch Changes

- [#127](https://github.com/aio-proxy/aio-proxy/pull/127) [`d95834a`](https://github.com/aio-proxy/aio-proxy/commit/d95834ad85ea0352f5c389497ea008c687a80d64) Thanks [@baranwang](https://github.com/baranwang)! - core: upgrade the bundled Bun runtime to the 1.4 line so proxied streaming passthrough no longer drops the request body. Bun 1.3.x silently discarded a `ReadableStream` request body when `fetch` used a proxy, so `api` providers with a `proxy` configured hung until timeout on streaming requests (e.g. `openai-response` passthrough). The compiled binary embeds the build-time Bun runtime, so this is delivered by pinning the build toolchain to Bun 1.4.

## 0.4.0

### Minor Changes

- [#124](https://github.com/aio-proxy/aio-proxy/pull/124) [`2d1d035`](https://github.com/aio-proxy/aio-proxy/commit/2d1d03580db04a8ff957df3b3dd17d0879599282) Thanks [@baranwang](https://github.com/baranwang)! - i18n: restructure message keys into nested namespaces and add Traditional Chinese (zh-Hant), Japanese (ja), and Korean (ko) locales

  - Flat `cli_*`/`common_*`/`error_*`/`wizard_*` keys are now nested, dot-layered namespaces (e.g. `cli.provider.login.unknown_vendor`); dashboard/oauth/brand keys are regrouped under the same scheme.
  - Added `zh-Hant`, `ja`, and `ko` locales; `resolveLocale` now maps `zh-hant`/`zh-tw`/`zh-hk`/`zh-mo`, `ja`/`ja-*`, and `ko`/`ko-*` tags to them.
  - Removed keys that did not need translation (protocol acronyms, `N/A`, `API Key`, and similar) and inlined them at their call sites.
  - Stripped trailing sentence periods from all message values across every locale.

### Patch Changes

- [#121](https://github.com/aio-proxy/aio-proxy/pull/121) [`8c1e690`](https://github.com/aio-proxy/aio-proxy/commit/8c1e69073e52a2921101c767b6d020484b59f857) Thanks [@baranwang](https://github.com/baranwang)! - ci: fix Docker image publish reading the renamed `published-packages` output from changesets/action, so the GHCR image is tagged and pushed again on release

- [#123](https://github.com/aio-proxy/aio-proxy/pull/123) [`d460128`](https://github.com/aio-proxy/aio-proxy/commit/d4601280f29a5322a30b4baa516bc1906d0ea324) Thanks [@baranwang](https://github.com/baranwang)! - cli: fix the managed service becoming unreachable after `brew upgrade`. The service unit now records the stable PATH launcher instead of the version-pinned Cellar binary, `service restart` regenerates an already-installed unit with a freshly resolved executable (recovering units that still point at a deleted old binary), and `resolveExec` falls back to the PATH launcher when the running executable was deleted mid-upgrade. `aio-proxy upgrade` now always restarts a managed daemon after upgrading (the `--restart` flag is removed); a manually started daemon still gets a self-restart hint.

## 0.3.0

### Minor Changes

- [#117](https://github.com/aio-proxy/aio-proxy/pull/117) [`55d3ccd`](https://github.com/aio-proxy/aio-proxy/commit/55d3ccd49cb6819b8a413050a7a668efc9df17c0) Thanks [@baranwang](https://github.com/baranwang)! - cli: publish a multi-arch (amd64/arm64) Docker image to GHCR on release, and add a Dockerfile and docker-compose example for running aio-proxy in a container

### Patch Changes

- [#120](https://github.com/aio-proxy/aio-proxy/pull/120) [`38960fd`](https://github.com/aio-proxy/aio-proxy/commit/38960fd9fca94d3e38cb5277a5eb928a3962d96a) Thanks [@baranwang](https://github.com/baranwang)! - core: accept `role: "system"` messages on the Anthropic Messages endpoint (matching the official SDK's `MessageParam` union) and surface Zod validation path detail in 400 responses without leaking request values

- [#116](https://github.com/aio-proxy/aio-proxy/pull/116) [`5a6deb7`](https://github.com/aio-proxy/aio-proxy/commit/5a6deb759ed7c748369db2dee814d2686dcd2e8d) Thanks [@baranwang](https://github.com/baranwang)! - server: end streamed request traces at the upstream terminal frame instead of socket EOF, so traces no longer stay "running" after the model finished. Raw passthrough resolves completion at the terminal frame across all four protocols and the AI SDK path at the finish part, without ending the client stream. Adds a configurable upstream idle timeout (300s default) that cancels a stalled upstream and errors the client stream rather than closing it cleanly. OpenAI-compatible passthrough treats [DONE] (not finish_reason) as terminal so trailing include_usage accounting is still captured; session commit stays gated on true stream EOF.

## 0.2.1

### Patch Changes

- [#114](https://github.com/aio-proxy/aio-proxy/pull/114) [`23457e3`](https://github.com/aio-proxy/aio-proxy/commit/23457e3c2a4f306460a25aa6252e477f3bbec6ec) Thanks [@baranwang](https://github.com/baranwang)! - release: verify the end-to-end publish + single `v<version>` tag + GitHub Release flow. No user-facing behavior change.

## 0.2.0

### Minor Changes

- [#109](https://github.com/aio-proxy/aio-proxy/pull/109) [`2fdb662`](https://github.com/aio-proxy/aio-proxy/commit/2fdb662f1449087dac370988e41793760b3c4c53) Thanks [@baranwang](https://github.com/baranwang)! - cli: add a `dashboard` command that probes the running daemon and opens the web dashboard in the default browser, resolving host/port via the same control-plane logic as `status`/`doctor` (with `--host`/`--port` overrides). Exits nonzero without opening a browser when the daemon is unreachable.

- [#109](https://github.com/aio-proxy/aio-proxy/pull/109) [`2fdb662`](https://github.com/aio-proxy/aio-proxy/commit/2fdb662f1449087dac370988e41793760b3c4c53) Thanks [@baranwang](https://github.com/baranwang)! - cli: add an `upgrade` command that detects the install method (brew/bun/npm/pnpm/binary) and upgrades `aio-proxy` in place. Package-manager channels re-install a registry-pinned `pkg@version`; the binary channel does an atomic self-replace with `--version` verification, automatic rollback, and backup sweep. Supports `--check`, `--force`, `--restart`, and `--registry`, and hints to restart a running daemon.

### Patch Changes

- [#109](https://github.com/aio-proxy/aio-proxy/pull/109) [`2fdb662`](https://github.com/aio-proxy/aio-proxy/commit/2fdb662f1449087dac370988e41793760b3c4c53) Thanks [@baranwang](https://github.com/baranwang)! - ingress: tolerate unknown `detail` values on OpenAI Responses `input_image` parts. Clients such as Codex send `detail: "original"`, which previously failed the input-item union and rejected the whole request with `400 Invalid OpenAI Responses request` before any provider routing. Unrecognized values are now coerced to `undefined` (a best-effort hint), matching how downstream code already treats `detail`.
