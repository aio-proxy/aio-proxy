# CLI Redesign Design

## Goal

Redesign the `aio-proxy` command-line surface around community conventions for a
single long-running daemon with a local control plane (Caddy, Ollama, Tailscale,
PM2 as references; clig.dev and the Twelve-Factor App as principles). The current
CLI grew ad hoc (`serve`, plus stub `dashboard`/`model`/`trace`); this spec defines
the target surface from scratch, independent of the current implementation.

This is a design spec. It defines the intended command surface and the conventions
that bind it. It is not an implementation plan and does not schedule code changes.

## Design Principles

- **Single daemon, flat lifecycle verbs.** aio-proxy is one proxy service, not a
  multi-process manager. Lifecycle verbs live at the top level (like `caddy run`,
  `tailscale up`), not under a noun. Domain operations use `noun verb` subtrees.
- **The app never daemonizes itself.** Following Twelve-Factor, the process runs in
  the foreground and never forks, writes PID files, or manages its own restarts.
  Backgrounding, restart-on-crash, and boot-start are delegated to the OS service
  manager (systemd/launchd) or a shell (`run &`).
- **Prefer the file watcher; add one narrow admin endpoint only if needed.** The
  server already auto-reloads on config-file change. Any CLI control action that is
  not covered by the watcher must call a purpose-built, loopback-only admin endpoint
  — it must NOT try to reuse the browser-oriented `/dashboard/api/*` routes, which
  are CSRF- and password-gated (see Control Plane). No self-built socket/RPC layer,
  no self-built supervisor process.
- **Human-first (clig.dev).** Verbs are commands, nouns are options; kebab-case;
  interactive prompts are allowed but always overridable via `--yes`/`--json` for
  scripting.

## Command Tree

```
aio-proxy [global flags] <command> [subcommand] [args] [flags]
│
├─ run                     Foreground blocking run; logs to stdout/stderr.
│                          Service units, containers, and terminals all execute this.
├─ reload                  Force a config reload (see Control Plane; complements the watcher).
├─ status  [--deep]        Liveness/port/version via /health; --deep adds provider health.
│
├─ service                 The only "background daemon" path → delegate to the OS.
│   ├─ install [--user|--system]   Generate launchd plist / systemd unit (ExecStart=…run).
│   ├─ uninstall
│   ├─ start | stop | restart      Thin wrappers over launchctl / systemctl.
│   └─ status
│
├─ config                  Configuration file (read-focused; see Open Question).
│   ├─ show                Print effective config (secrets redacted).
│   ├─ edit                Open the config file in $EDITOR (comment-safe).
│   ├─ validate [path]     Validate before applying.
│   └─ path                Print the config file path.
│
├─ plugin                  The only package-install entry point (source of capabilities).
│   ├─ add <package>       Install npm package + configuration flow.
│   ├─ list
│   ├─ config <package>    Edit plugin config/secrets.
│   ├─ remove <package>
│   └─ prune               Remove unreferenced installed packages.
│
├─ provider                Only operates upstream entries in config (runtime; installs nothing).
│   ├─ login  [capability] [--provider <id>]   Log in → produce one provider.
│   ├─ list   [--probe]
│   ├─ show <provider-id>
│   ├─ test <provider-id>
│   └─ remove <provider-id>
│
└─ doctor / dashboard / completion / version
```

## Global Flags

| Flag | Purpose |
|---|---|
| `-v, --version` | Print version. |
| `-h, --help` | Help. |
| `--config <path>` | Override the config file location. |
| `--lang <locale>` | Output language. |
| `--json` | Machine-readable output. Scoped to a named subset (`status`, `provider list`, `config show`); not every command. |
| `--no-color` | Disable colored output. |
| `--log-level <q\|error\|info\|debug>` | Log level (does not consume `-v`). |

## Lifecycle: Only `run`

There is deliberately **no top-level `start`/`stop`/`restart`/`logs`**. Self-backgrounding
plus a PID file is a Twelve-Factor anti-pattern and duplicates what the shell and OS
already do better.

| Need | Solution |
|---|---|
| Foreground / terminal | `aio-proxy run` |
| Temporary background | `aio-proxy run &` / `nohup aio-proxy run &` / tmux/screen |
| True always-on (boot + crash restart) | `aio-proxy service install` |

Only `run`, `reload`, and `status` sit at the top level.

| Command | What it does | Mechanism |
|---|---|---|
| `run` | Foreground; graceful shutdown on SIGTERM | Process itself |
| `reload` | Force a config reload now | Admin endpoint (see Control Plane) |
| `status [--deep]` | Liveness/port/version; `--deep` adds provider health | `/health` + providers endpoint (see Control Plane) |

## `service`: OS-Delegated Daemon

`service` is the single path for a persistent daemon. Its generated unit always points
`ExecStart` at `run` (never at a self-backgrounding command). Boot-start and
restart-on-crash come for free from the unit directives; aio-proxy writes no supervisor
logic of its own.

| Command | macOS | Linux |
|---|---|---|
| `install` | Write a LaunchAgent plist | Write a systemd user unit |
| `start` / `stop` / `restart` | `launchctl` | `systemctl --user` |
| `status` | Read launchd state | Read systemd state |

Because there are no top-level `stop`/`restart` verbs, there is no ambiguity about
"is the OS managing this?" — managed lifecycle always goes through `service`.

## Domain Subtrees

Concept chain:

```
plugin add <pkg>  --installs npm package-->  capability  --provider login-->  provider (a key in config.providers)
```

| Subtree | Verbs | Object |
|---|---|---|
| `plugin` | add / list / config / remove / prune | npm packages (source of capabilities) |
| `provider` | login / list / show / test / remove | upstream entries in config |
| `config` | show / edit / validate / path | the config file itself |

Installation is unified under `plugin add`. There is no `provider add`/`provider install`:
a provider is not an installable artifact, it is an entry produced by `provider login`.
Today's `provider install` is a strict subset of `plugin add` (thin `npmAdd` + trust
confirm, versus the full descriptor/config/secret flow), so removing it loses nothing.
The new-user path is two explicit steps: `plugin add <pkg>` then `provider login`.

`plugin`/`provider`/`config` follow `noun verb`, and shared verbs stay consistent across
objects (`list`/`remove` mean the same thing everywhere).

## Logs

Following Twelve-Factor, `run` writes its event stream to stdout/stderr and the execution
environment captures it. There is no `aio-proxy logs` command.

Note on current behavior: the logger already installs a console sink by default, so
stdout/stderr is the default today. An **opt-in** file sink exists behind
`server.logging.enabled` (time-rotating, under `logging.dir ?? <home>/logs`). This spec
does not require removing that opt-in file sink; it only asserts the CLI has no `logs`
command and the daemon never manages logs on the user's behalf by default. If the
opt-in `server.logging` surface is to be removed, that is a separate breaking
config-surface change and must be listed as its own delta.

| Context | Where logs go | How the user reads them |
|---|---|---|
| `run` (terminal) | stdout/stderr | The terminal |
| `service` (systemd) | Captured by journald | `journalctl --user -u aio-proxy -f` |
| `service` (launchd) | plist `StandardOutPath`/`StandardErrorPath` -> file | `tail -f <that file>` |
| Docker | Container stdout | `docker logs -f` |

## Exit Codes

Exit codes are a contract with the OS service manager: they decide whether a crashed
process is restarted. This taxonomy is a **new** contract; it does not describe current
behavior (today the top-level catch maps every error to `1`, and the `dashboard`/`model`
stubs use `2` for "not implemented"). Implementing it requires reworking both.

| Code | Meaning | Service-unit behavior |
|---|---|---|
| `0` | Normal exit | No restart |
| `1` | Unrecoverable (bad config, port already in use) | Pair with `RestartPreventExitStatus=1` -> do not restart; retrying is futile |
| `>=2` | Transient crash | `Restart=on-failure` -> restart |

`run` must map "retry-is-futile" startup failures (invalid config, port conflict) to a
fixed non-retryable code, and transient faults to a retryable code, so the unit's restart
policy behaves correctly.

## Control Plane

This is the load-bearing section. The reload/status verbs cannot simply "reuse existing
endpoints" — the relevant machinery today is either browser-gated or does not carry the
needed data.

Current state (verified against `packages/server/src/server/server.ts` and
`dashboard-routes/config.ts`):

- **Config watcher already exists and is on by default.** The server watches the config
  path (`watchConfig !== false`) and reloads the snapshot on file change. So after
  `config edit` (or any file write), a reload happens automatically.
- **There is no top-level `/reload`.** The only reload route is
  `POST /dashboard/api/reload`, stacked behind three middlewares: loopback check, a CSRF
  origin check (a CLI `fetch` sends no `Origin` and gets `403`), and dashboard auth
  (`401`/`503` when a password is set). A plain CLI call cannot use it.
- **`/health` carries no provider data.** It returns `{ status, uptime, version }` only,
  and `version` is currently the hardcoded literal `'0.0.0'`. Provider reachability lives
  behind `GET /dashboard/api/providers?probe=true`, which is also behind dashboard auth,
  so today's `provider list --probe` already fails with `401` whenever a password is set.

Design decisions this forces:

1. **`reload`:** Primary reconfiguration is the file watcher (implicit reload on write).
   CLI `reload` is the *explicit/forced* path (e.g. watcher disabled, or out-of-band
   secret rotation). To back it, add a purpose-built **loopback-only, non-CSRF,
   non-password admin endpoint** (e.g. `POST /admin/reload`, authorized by loopback
   and/or a state-dir token file), owned by this redesign as a real deliverable. Do not
   route the CLI through `/dashboard/api/reload`. If the watcher covers all real cases,
   `reload` may be dropped entirely instead.
2. **`status`:** Shallow `status` uses `/health` for liveness/port/version — and `/health`
   must be fixed to emit the real version instead of `'0.0.0'`. Deep `status` (and
   `provider list --probe`) needs the providers/probe data; the spec must define how the
   CLI authenticates to it on loopback (loopback-exempt from the password, or a token
   file), rather than inheriting the current `401`-when-password-set limitation silently.

No new socket or RPC layer is introduced; the only new surface is at most one narrow,
loopback-scoped admin HTTP endpoint plus a `/health` version fix.

## Deltas From Current CLI

These are the differences between this target design and today's CLI/server. They are
recorded for planning; this spec does not schedule or perform them.

1. `serve` -> `run` (rename).
2. Add top-level `reload` and `status`; add the whole `service` subtree.
3. Add `config` (`show`/`edit`/`validate`/`path`), `doctor`, and `completion` subtrees.
4. Remove `provider install`; installation folds into `plugin add`.
5. Control plane: add a loopback-only admin `reload` endpoint (or drop CLI `reload` in
   favor of the watcher); fix `/health` to report the real version; define how deep
   `status`/`--probe` authenticate on loopback.
6. Remove the unused `pidPath()` and `logPath()` helpers from `packages/core/paths`
   (dead/aspirational today; file logging goes to `<home>/logs`, not `logPath()`), so
   the code matches the "no PID file" stance.
7. Rework exit codes: replace the blanket `exitCode = 1` catch and the stub `exitCode = 2`
   with the taxonomy above.
8. (If desired, separately) remove the opt-in `server.logging` file sink — a breaking
   config-surface change, not implied by the default stdout behavior.

## Non-Goals

- No self-built supervisor/monitor process (no PM2/Syncthing-style crash-restart loop);
  aio-proxy is a single-process daemon with no "OS-can't-reach-it" scenario that would
  justify the added complexity.
- No top-level self-backgrounding (`start`) or PID-file management.
- No self-built socket/RPC control channel beyond at most one narrow loopback-only admin
  HTTP endpoint.
- No routing the CLI through the browser-oriented, CSRF/password-gated `/dashboard/api/*`
  routes.
- No implementation, migration steps, or test plan -- those belong to a follow-up plan.

## Open Question (resolved recommendation)

**`config` write verbs.** Recommendation: ship `show` / `edit` / `validate` / `path`; do
**not** ship `config set` / `get` scalar mutation against the current serializer.

Reason (verified in `packages/core/src/plugins/config-file/serialization.ts`): the read
path uses `JSON5.parse` / `YAML.parse` (comments allowed), but the write path uses
`JSON.stringify(..., 2)` for `.json`/`.jsonc`. Any `config set` that round-trips through
`AtomicConfigFile.replace` would **silently strip all comments** from a user's
`config.jsonc` — hostile for a file whose default ships with a `$schema` line and is
meant to be hand-edited.

- `config edit` is safe: it hands raw file text to `$EDITOR`; comments survive; `config
  validate` + the watcher close the loop. Any CLI write must go through the same
  cross-process-locked `AtomicConfigFile.replace` as the dashboard, never a naive
  `writeFileSync`, to avoid racing the daemon.
- `config set` / `get` are out of scope until a comment-preserving edit (e.g.
  `jsonc-parser` `modify`/`applyEdits`) replaces the stringify write path. If `set` is
  wanted later, that serializer change is a prerequisite deliverable, not an assumption.

Also note: `config path` / `config validate` must handle all resolved config extensions
(`config.json` / `.jsonc` / `.yaml` / `.yml`), since `configPath()` resolves any of them.
