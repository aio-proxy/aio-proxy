---
slug: cli-redesign
status: awaiting-approval
intent: clear
pending-action: write .omo/plans/cli-redesign.md (already scaffolded and filled)
approach: One-shot destructive P1 that unifies CLI naming, i18n coverage, filesystem home dir, and fixes silent bugs; daemon lifecycle (P2), URL discovery + destructive renames (P3), and reserved-group implementations (P4) are OUT of this plan.
---

# Draft: cli-redesign

## Components (topology ledger)

| id | outcome | status | evidence |
| --- | --- | --- | --- |
| paths | Single-source path module `packages/core/src/paths.ts`; three current resolvers migrated onto it; default home dir `~/.aio-proxy`. | active | packages/cli/src/config-path.ts, packages/core/src/db/open-db.ts:80-92, packages/core/src/npm.ts:42-49, packages/core/src/npm-list.ts:13 |
| cli-surface | Unified placeholder names (`<package>`, `<vendor>`, `<provider-id>`); every provider subcommand and every option description migrated to `@aio-proxy/i18n`. | active | packages/cli/src/main.ts:134-173, packages/cli/src/provider-commands.ts:55-88 |
| serve-fix | `serve --dashboard` (broken no-op) → `serve --open` (real openBrowser); serve startup log moved from stdout to stderr. | active | packages/cli/src/main.ts:107-130,146 |
| tests | `packages/cli/_test/cli-test-helpers.ts` `cliServeArgs` drops `--config` and injects `AIO_PROXY_HOME` env; existing CLI tests adjusted. | active | packages/cli/_test/cli-test-helpers.ts:44-51, packages/cli/_test/cli.test.ts, packages/cli/_test/provider-commands.test.ts |

## Open assumptions (announced defaults)

| assumption | adopted default | rationale | reversible? |
| --- | --- | --- | --- |
| Home dir name | `~/.aio-proxy` (flat, single dot-dir) | User explicitly asked for this over XDG. | yes |
| Env override name | `AIO_PROXY_HOME` | Already used by `open-db.ts`; do not invent a second name. | yes |
| Old dir migration | none — users re-login OAuth and re-install runtime packages once | User explicitly said "不管旧数据". | yes |
| Reserved groups | Keep `model` and `trace` as stub GROUPS (not leaves), no subcommands yet | User answered "都留". | yes |
| Naming renames (`test`→`probe`, `--url` removal, `list --installed`→`packages`) | DEFERRED to P3 | Break the CLI surface in one wave later, not mixed with P1's home-dir move. | yes |
| Daemon commands (`stop`/`status`/`logs`, `serve --detach`) | DEFERRED to P2 | Requires stderr-log migration to land first (P1 does it), then can be built cleanly. | yes |
| Dashboard URL discovery (`AIO_PROXY_URL` + config-derived) | DEFERRED to P3 | Behavior change; do it together with the `--url` flag removal. | yes |
| i18n locale coverage | English source strings in `en.json`; `zh-Hans.json` gets `TODO(i18n): <English source>` placeholders for the same keys; no other locale file exists in this repo | `packages/i18n/project.inlang/settings.json:3-8` configures only `en` and `zh-Hans`. | yes |

## Findings (cited - path:lines)

- CLI entry `buildProgram()` — `packages/cli/src/main.ts:134-173`.
  - Root command has `-v/--version` and `--lang <locale>`.
  - `serve --host --port --dashboard --config` — but `serve()` handler never reads `options.dashboard`. Silent no-op. `main.ts:107-130` vs `main.ts:146`.
  - `dashboard`, `model`, `trace` bound to `runStub = () => {}`. `main.ts:132,150,169-170`.
  - `provider install <pkg>`, `provider list`, `provider login <family>`, `provider test <id>` — placeholders inconsistent (`<pkg>`, `<family>`, `<id>`).
  - Provider subcommand descriptions and every option description are hardcoded English (`main.ts:154-168`), while top-level commands use `m.cli_*()` i18n.
- `provider test <id>` is a synonym for `provider list --filter <id> --probe`. `packages/cli/src/provider-commands.ts:276-278`.
- `provider list --installed` calls `listInstalledNpmPackages()` (on-disk cache) while `provider list` (no flag) fetches `/dashboard/api/providers` from a running server. One flag toggles two unrelated data sources. `packages/cli/src/provider-commands.ts:254-285`.
- Filesystem — three unrelated resolvers, only one honors an env variable:
  - `config.jsonc` → `~/.config/aio-proxy/`, no env override. `packages/cli/src/config-path.ts:9`. `AIO_PROXY_CONFIG` env AND `--config` flag both point at the file.
  - `aio-proxy.db` → honors `$AIO_PROXY_HOME` → `$XDG_CONFIG_HOME/aio-proxy` → `~/.config/aio-proxy`. `packages/core/src/db/open-db.ts:80-92`.
  - npm cache → `~/.config/aio-proxy/cache/packages/`, no env override. `packages/core/src/npm.ts:44`, `packages/core/src/npm-list.ts:13`.
- Test helpers currently rely on `--config <path>` to point at fixtures: `packages/cli/_test/cli-test-helpers.ts:44-51`. `AIO_PROXY_HOME` is not currently injected in `cliEnv`.
- Serve startup line prints to stdout — `main.ts:124-129`. Any future pipe consumer that expects data on stdout will be polluted. Migration to stderr is prerequisite for P2 daemon detach.

## Decisions (with rationale)

1. **Single home dir under `~/.aio-proxy`** with `AIO_PROXY_HOME` env override. Delete `--config` flag AND `AIO_PROXY_CONFIG` env. Rationale: user picked flat over XDG; reuse the existing env name; one resolver via new `packages/core/src/paths.ts`.
2. **`serve --dashboard` → `serve --open`** with real `openBrowser()` wiring. Rationale: current flag is a silent no-op; the rename doubles as a bug fix and semantics fix.
3. **Serve startup log → stderr.** Rationale: prerequisite for P2 daemon and for the emerging "stdout = data, stderr = logs/progress" convention.
4. **Placeholders unified in P1** (`<package>`/`<vendor>`/`<provider-id>`), but **command renames deferred to P3** (`test`→`probe`, `--url` removal, `list --installed`→`packages`). Rationale: text-only renames are non-breaking; command renames break the public surface — do them in one dedicated wave later.
5. **Full i18n coverage for provider subcommands and every option** in P1. Rationale: user asked for unification; the i18n gap is one of the concrete inconsistencies enumerated in the current-state audit.
6. **`model` and `trace` stay as command GROUPS with no subcommands in P1.** Rationale: user chose to keep both; empty groups still preserve the reserved noun in `--help` without lying about capability. Their `runStub` leaf implementations are removed — the group itself is the placeholder.
7. **No migration of `~/.config/aio-proxy`.** Rationale: user explicitly said "不管旧数据". Users re-login OAuth and re-install packages once; documented in CHANGELOG.
8. **P1 is destructive but atomic**: home dir + `--config` removal + i18n + placeholder rename + serve-open fix + serve-stderr fix ship in one release. Rationale: they all touch the same test helpers and CHANGELOG entry; splitting them makes the interim state worse than either endpoint.

## Scope IN

Everything in P1 as defined above. Concretely:

- New `packages/core/src/paths.ts` as single source of truth.
- Delete `packages/cli/src/config-path.ts`; migrate callers.
- Migrate `open-db.ts`, `npm.ts`, `npm-list.ts` off `~/.config/aio-proxy`.
- Delete `--config` flag from every command; delete `AIO_PROXY_CONFIG` env from `resolveConfigPath`.
- Rename argument placeholders `<pkg>`→`<package>`, `<family>`→`<vendor>`, `<id>`→`<provider-id>`.
- `provider login <vendor>` accepts both short (`copilot`/`chatgpt`) and long (`github-copilot`/`openai-chatgpt`) forms.
- Every provider subcommand description and every CLI option description reads from `@aio-proxy/i18n`. New keys added; deleted keys removed. English source strings only.
- Fix `serve --dashboard` → rename to `--open`, wire to `openBrowser()`.
- Move serve startup log from stdout to stderr.
- Remove `runStub` bindings for `dashboard`, `model`, `trace`; keep `model` and `trace` as groups with no subcommands; `dashboard` remains a leaf that will be implemented in P3 — for P1 it prints a "not yet implemented" message on stderr and exits 2 (loud, not silent).
- Rewrite `packages/cli/_test/cli-test-helpers.ts:44-51` `cliServeArgs`: drop `--config`, inject `AIO_PROXY_HOME=<tmpdir>` via `cliEnv`.
- Update `packages/cli/_test/cli.test.ts` and `packages/cli/_test/provider-commands.test.ts` for the placeholder + i18n changes.

## Scope OUT (Must NOT have)

- `AIO_PROXY_URL` env, config-derived dashboard URL, or ANY change to `--url` / `--dashboard-url`. All P3.
- `stop` / `status` / `logs` / `serve --detach` commands. All P2.
- `provider test` → `provider probe` rename. P3.
- `provider list --installed` → `provider packages` split. P3.
- Actual `dashboard` command implementation (openBrowser to auto-discovered URL). P3.
- `model list` implementation and any `/dashboard/api/models` endpoint work. P4.
- `trace list` / `trace show` implementation and any trace storage / `/dashboard/api/traces` endpoint work. P4.
- Any migration of `~/.config/aio-proxy` to `~/.aio-proxy`.
- Global `--json` flag on the root command. Deferred (implicit P3 with the URL rework).
- zh-Hans translations for the new i18n keys (values remain `TODO(i18n): ...` in P1). Owned by the i18n author; tracked separately. No other locale files exist in this repo.
- System service integration (launchd / systemd / SCM). No planned phase.

## Open questions

None. Awaiting approval to write the plan (already scaffolded).

## Approval gate

status: awaiting-approval
