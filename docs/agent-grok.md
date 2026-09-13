# Grok Build

Connect Grok Build to a local aio-proxy without pasting API keys or refresh tokens. Grok runs the AIO Proxy helper when it needs to log in or refresh. aio-proxy does not restore previous Grok cloud sessions.

Verified floor: Grok `1.0.24` on macOS arm64 during design probes. **Linux and other platforms are not claimed compatible here.** This runner did not execute a real Grok host, a 15-minute natural access-token expiry, macOS `sandbox-exec` egress capture, or a compiled `darwin-arm64` binary against that host.

## Shortest journey

1. Start aio-proxy on loopback (default `http://127.0.0.1:9317`). Device approval needs a Dashboard password when `server.apiKeys` is set.
2. `aio-proxy agent configure grok`
3. `grok login` — Grok starts the helper. Approve the device request in the Dashboard. Do not paste tokens.
4. `grok models`
5. `grok -m <aio-proxy-model-id>`

configure writes Grok's global config and installation files only. It does not start Grok, does not start the proxy, and does not issue tokens. Close Grok settings if they are open so the new helper command reloads.

## `GROK_HOME`

The helper inherits `GROK_HOME` from the Grok process. Unset, the root is `~/.grok`. Absolute paths and `~/…` are accepted; other relative paths are rejected. The helper does not search a project `.grok` or another installation. A mismatched installation ID fails instead of authorizing a different install.

## Login, models, and keys

Login is `grok login`. The native entry label is `AIO Proxy`. You do not set `XAI_API_KEY` for this path. Grok chooses when to call the helper; aio-proxy does not inject a refresh token into Grok.

Pick a model from `grok models` (or Grok's `/model` UI), then pass that id to `grok -m`. configure does not change `[models].default`.

## List drift

`aio-proxy agent list` keeps a Grok installation visible when the seven managed fields drifted. `configuration` is `current`, `modified`, `missing`, or `recovery_required`. Catalog schema for Grok is `host_managed` / `not_applicable`. Drift is not the same as an invalid marker. `--check` and `--authorizations` talk to the local control plane; they do not print access or refresh tokens.

## Remove

`aio-proxy agent remove grok` revokes this installation and restores managed fields that you did not edit. User edits, comments, and unrelated Grok files stay. Grok's `auth.json` is not read or rewritten. Offline revoke failure keeps a recoverable record instead of deleting ownership blindly.

## Fresh 401

If a just-issued access token is rejected with 401, Grok may skip refresh (`current token freshly minted`) and fail that turn. aio-proxy does not fake issue times to bypass that host limit. Re-run `grok login` when Grok asks. Concurrent Grok processes that share one installation may see a native retry or a fresh-token failure after the other process refreshes; silent recovery of every 401 is not promised.
