# aio-proxy

## 0.2.1

### Patch Changes

- [#114](https://github.com/aio-proxy/aio-proxy/pull/114) [`23457e3`](https://github.com/aio-proxy/aio-proxy/commit/23457e3c2a4f306460a25aa6252e477f3bbec6ec) Thanks [@baranwang](https://github.com/baranwang)! - release: verify the end-to-end publish + single `v<version>` tag + GitHub Release flow. No user-facing behavior change.

## 0.2.0

### Minor Changes

- [#109](https://github.com/aio-proxy/aio-proxy/pull/109) [`2fdb662`](https://github.com/aio-proxy/aio-proxy/commit/2fdb662f1449087dac370988e41793760b3c4c53) Thanks [@baranwang](https://github.com/baranwang)! - cli: add a `dashboard` command that probes the running daemon and opens the web dashboard in the default browser, resolving host/port via the same control-plane logic as `status`/`doctor` (with `--host`/`--port` overrides). Exits nonzero without opening a browser when the daemon is unreachable.

- [#109](https://github.com/aio-proxy/aio-proxy/pull/109) [`2fdb662`](https://github.com/aio-proxy/aio-proxy/commit/2fdb662f1449087dac370988e41793760b3c4c53) Thanks [@baranwang](https://github.com/baranwang)! - cli: add an `upgrade` command that detects the install method (brew/bun/npm/pnpm/binary) and upgrades `aio-proxy` in place. Package-manager channels re-install a registry-pinned `pkg@version`; the binary channel does an atomic self-replace with `--version` verification, automatic rollback, and backup sweep. Supports `--check`, `--force`, `--restart`, and `--registry`, and hints to restart a running daemon.

### Patch Changes

- [#109](https://github.com/aio-proxy/aio-proxy/pull/109) [`2fdb662`](https://github.com/aio-proxy/aio-proxy/commit/2fdb662f1449087dac370988e41793760b3c4c53) Thanks [@baranwang](https://github.com/baranwang)! - ingress: tolerate unknown `detail` values on OpenAI Responses `input_image` parts. Clients such as Codex send `detail: "original"`, which previously failed the input-item union and rejected the whole request with `400 Invalid OpenAI Responses request` before any provider routing. Unrecognized values are now coerced to `undefined` (a best-effort hint), matching how downstream code already treats `detail`.
