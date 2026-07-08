---
"@aio-proxy/cli": major
---

Unify the CLI home directory, retire `--config`, and fix two silent `serve` bugs.

- Default filesystem home dir moves from `~/.config/aio-proxy` to `~/.aio-proxy`. Set `AIO_PROXY_HOME` to override.
- The `--config <path>` flag and the `AIO_PROXY_CONFIG` env variable are removed. Use `AIO_PROXY_HOME` instead.
- `serve --dashboard` is renamed to `serve --open` and now actually opens the dashboard in your default browser after startup.
- The `serve` startup log line now writes to stderr instead of stdout so scripts can safely pipe stdout.
- The `dashboard` command declares itself as not yet implemented (exit code 2 to stderr). Existing subcommand groups `model` and `trace` print group help.
- Existing OAuth logins and installed provider packages live under the old `~/.config/aio-proxy`; users must re-login and re-install once after upgrading.
