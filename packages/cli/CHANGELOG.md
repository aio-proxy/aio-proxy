# @aio-proxy/cli

## 1.0.0

### Major Changes

- 3ac521f: Unify the CLI home directory, retire `--config`, and fix two silent `serve` bugs.

  - Default filesystem home dir moves from `~/.config/aio-proxy` to `~/.aio-proxy`. Set `AIO_PROXY_HOME` to override.
  - The `--config <path>` flag and the `AIO_PROXY_CONFIG` env variable are removed. Use `AIO_PROXY_HOME` instead.
  - `serve --dashboard` is renamed to `serve --open` and now actually opens the dashboard in your default browser after startup.
  - The `serve` startup log line now writes to stderr instead of stdout so scripts can safely pipe stdout.
  - The `dashboard` command declares itself as not yet implemented (exit code 2 to stderr). Existing subcommand groups `model` and `trace` print group help.
  - Existing OAuth logins and installed provider packages live under the old `~/.config/aio-proxy`; users must re-login and re-install once after upgrading.

- 861c5f8: Replace vendor-specific OAuth support with a public OAuth plugin SDK, embedded GitHub Copilot and OpenAI ChatGPT plugins, host-owned authorization and vault persistence, and read-only plugin diagnostics.

  This is a clean break: legacy OAuth provider configuration and stored credentials are not migrated. Remove legacy OAuth providers and log in again to create plugin-backed accounts.

  OAuth capabilities can now expose validated icons, including an exact build-generated LobeHub static icon key type.

  OAuth adapters can now expose validated quota snapshots and optional account-level reset operations through a snapshot-isolated host service.

### Patch Changes

- Updated dependencies [861c5f8]
  - @aio-proxy/plugin-sdk@1.0.0
  - @aio-proxy/core@1.0.0
  - @aio-proxy/dashboard@1.0.0
  - @aio-proxy/logger@1.0.0
  - @aio-proxy/server@1.0.0
  - @aio-proxy/i18n@1.0.0
  - @aio-proxy/types@1.0.0
