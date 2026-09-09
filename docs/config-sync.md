# Configuration sync

Configuration sync is owned by the running AIO Proxy service. The Dashboard and
`aio-proxy sync` use the same control plane, previews, authentication checks, and
local activation rules. The CLI never opens the sync database or starts a second
sync engine.

## Start with a preview

The CLI resolves the service address from the same configured `server.host` and
`server.port` values used by `status`, `reload`, and `doctor`. If the service is
stopped, commands tell you to start it with `aio-proxy service start`.

When Dashboard authentication is enabled, the CLI asks for the Dashboard password
with a hidden terminal prompt. `--password-stdin` reads it without echoing it. The
password is exchanged for an in-memory bearer session and is never written to the
configuration, output, logs, or a cache. A model Provider API key is not a
Dashboard administration credential. With authentication disabled, requests still
carry the same-host `Origin` and keep the existing loopback and host checks.

Backend connection options are read from the local file named by
`--options-file`. They are sent only as the local connection input to the running
service. They are not printed in previews, saved by the CLI, or used as Dashboard
credentials.

Commands that can change shared state first print a redacted preview and an opaque
preview token:

```text
aio-proxy sync connect --plugin PACKAGE --capability ID --options-file PATH
aio-proxy sync join PROVIDER_ID
aio-proxy sync restore OBJECT_ID OPERATION_ID
aio-proxy sync purge --provider PROVIDER_ID
```

Use `aio-proxy sync apply PREVIEW_ID --decisions-file PATH` to cross the explicit
apply boundary. A preview is one-use, expires, and becomes stale when local or
cloud state changes. JSON mode always preserves this two-step flow so automation
cannot silently apply a preview.

## What is synchronized

New local Providers are excluded by default. A Provider discovered from the cloud
is included automatically when its dependencies and credentials can be activated;
otherwise it remains pending for review. Joining a Provider produces a preview
that shows redacted local and cloud changes and the allowed decisions.

The sync engine preserves environment references such as `{{env.NAME}}`, local
host and proxy settings, and machine-specific fields. Required plugin business
configuration and business secrets follow a selected Provider automatically.
Use `aio-proxy sync overrides OBJECT_ID --paths-file PATH` for explicit local
option paths. The file contains a JSON array of path-segment arrays, for example:

```json
[["region"], ["deployment", "name"]]
```

Overrides affect local activation and are reviewed through the same preview
boundary. They never edit SQLite directly.

Plugin dependencies are disclosed in previews. A missing or incompatible plugin,
missing environment value, invalid configuration, or unverified OAuth credential
leaves the affected entity pending while safe local Providers continue to run.

## History and removal

Configuration history is retained for 30 days. `history OBJECT_ID` lists available
operations, and `restore OBJECT_ID OPERATION_ID` creates a preview for an explicit
restore. Restoring configuration does not replay an old OAuth credential.

Leaving a Provider with `sync leave PROVIDER_ID` excludes it on this device while
keeping its cloud copy. Purging with `sync purge --provider PROVIDER_ID` previews
removal of the cloud configuration, history, and account. Plugin purge uses
`--plugin PACKAGE` and can be blocked while other Providers still depend on that
plugin. These operations have separate previews and separate confirmation.

Switching backends is also a reviewed operation. Connect the new backend, inspect
the preview, apply it, and then disconnect the old backend. Backend authorization,
identity, range, and local data-directory state remain local to this configuration
directory.

Shared OAuth credentials require confirmed remote coordination. A credential copied
to another device may remain pending until the exact adapter and version has
verified multi-device use. Refresh is deferred while offline, uncertain results
require login, and independent detachment requires an adapter-provided proof of a
separate usable authorization. The CLI's `sync detach PROVIDER_ID` starts the
existing local OAuth login-session flow and hands only that local session ID to the
service; it never accepts or prints an access token.

## Backend author guidance

Third-party backends register through the sync capability in the plugin SDK. The
backend must implement the SDK session contract, including versioned reads,
compare-and-swap writes, conditional removal, listing, cancellation, and disposal.
Run the SDK conformance helpers before publishing a backend:

<https://github.com/aiodotdev/aio-proxy/tree/main/packages/plugin-sdk/src/testing/sync-conformance.ts>

Connection options should expose only the fields needed by the backend and mark
secret fields for the existing form redaction rules. Never place credentials,
tokens, raw environment values, or machine paths in status, previews, errors, or
logs. Backend identity changes, offline behavior, quota handling, and unknown
write outcomes must be reported through the SDK error codes so the service can
preserve pending operations safely.

OAuth adapters should declare the credential format and evidence required for
multi-device use and independent detachment. An undeclared capability is treated
as unverified; it is never inferred from a successful login or from two token
strings that happen to differ.

## Verification and release status

From `packages/server`, the deterministic product acceptance scenario runs with
two real server states, separate configuration directories, and one shared
backend:

```sh
rtk proxy bun test --preload=./__tests__/setup.ts \
  src/sync-control-plane/acceptance.test.ts
```

It covers selected Provider and plugin synchronization, restart discovery,
redacted committed export, remote import without an entity echo, local exclusion,
purge, and preservation of an independent local copy. The release also requires
the CloudKit installed-path and launchd checks plus the adapter-specific OAuth
evidence described in the testing guides; deterministic fixtures never stand in
for those live gates.
