# cli-redesign - Work Plan

## TL;DR (For humans)

**What you'll get:** The aio-proxy CLI becomes internally consistent — one home directory (`~/.aio-proxy`) chosen by an environment variable instead of a per-command flag, unified argument names across every command, every command and option description available for translation, and two silent bugs in the `serve` command fixed. Nothing you already know how to do disappears; a couple of flags are renamed and one config flag is retired in favor of an environment variable.

**Why this approach:** Bundling the home-directory move, the flag/naming unification, and the two `serve` bug fixes into one release avoids leaving the CLI in a half-migrated state where some paths honor the new home dir and others don't. The bigger renames (`test`→`probe`, dropping `--url`, splitting `list --installed`) are deliberately held for a later release so the surface breaks in a single, dedicated wave.

**What it will NOT do:** It will not migrate your existing `~/.config/aio-proxy` files — you'll re-login OAuth and re-install runtime provider packages once. It will not add the background/daemon commands (`stop`/`status`/`logs`) yet. It will not implement the `dashboard`, `model`, or `trace` subcommands.

**Effort:** Medium
**Risk:** Medium — one-time breaking change to CLI flags, env var name, and default filesystem location; test suite must be updated in lockstep.
**Decisions to sanity-check:** flat `~/.aio-proxy` instead of XDG; no migration of old data; retiring `--config`/`AIO_PROXY_CONFIG` in favor of `AIO_PROXY_HOME`; keeping `model`/`trace` as empty command groups; deferring the destructive command renames to a later phase.

Your next move: approve to proceed, ask for a high-accuracy review before approving, or amend scope. Full execution detail follows below.

---

> TL;DR (machine): Medium effort, Medium risk. Unify CLI home dir under `~/.aio-proxy` w/ `AIO_PROXY_HOME`, delete `--config`/`AIO_PROXY_CONFIG`, unify placeholders/i18n, fix `serve --dashboard`→`--open`, move serve startup log to stderr; daemon lifecycle and destructive renames deferred.

## Scope
### Must have
- Single-source path module `packages/core/src/paths.ts` exporting `aioHome()`, `configPath()`, `dbPath()`, `packagesDir()`, `pidPath()`, `logPath()`.
- Home directory resolves as: `$AIO_PROXY_HOME` → `~/.aio-proxy`. No XDG lookup. No fallback to `~/.config/aio-proxy`.
- Deleted: `packages/cli/src/config-path.ts`, the `--config` flag from every command that has it, and the `AIO_PROXY_CONFIG` env variable.
- `packages/core/src/db/open-db.ts` `resolveDbPath()` collapses to `dbPath()` from `paths.ts`. No more XDG branch, no more `~/.config/aio-proxy` fallback.
- `packages/core/src/npm.ts:42-49` `npmPackageCacheDir(pkg)` and `packages/core/src/npm-list.ts:12-14` root path both derive from `packagesDir()`.
- CLI placeholders: `provider install <package>`, `provider login <vendor>`, filter args referring to configured providers use `<provider-id>` everywhere they appear in help text.
- `provider login <vendor>` accepts both short vendor aliases (`copilot`, `chatgpt`) and long forms (`github-copilot`, `openai-chatgpt`); the persisted `config.providers[*].vendor` shape is unchanged.
- Every provider subcommand description and every CLI option description across the whole CLI reads from `@aio-proxy/i18n` (`m.cli_*_description()`). No hardcoded English literal remains in `packages/cli/src/main.ts` or `packages/cli/src/provider-commands.ts` for user-facing descriptions.
- New i18n keys added to `packages/i18n/messages/en.json` (English source strings) and mirrored to `packages/i18n/messages/zh-Hans.json` with `TODO(i18n): <English source>` placeholders so the i18n author can translate later; `packages/i18n/src/paraglide/**` is regenerated via `bun run --cwd packages/i18n build`; deleted keys `cli_serve_option_config_description` and `cli_serve_option_dashboard_description` removed from both locale files.
- `serve --dashboard` renamed to `serve --open` AND wired: after the server binds successfully, if `options.open === true`, call `openBrowser(dashboardUrl)`.
- The "Server listening…" (or i18n equivalent) startup message emitted by `serve` writes to stderr, not stdout.
- `runStub` bindings for `dashboard`, `model`, `trace` are removed. `model` and `trace` become empty command GROUPS (`program.command("model")` with no `.action()` — commander prints the group help). `dashboard` stays a leaf that prints an i18n "not yet implemented" message to stderr and sets `process.exitCode = 2`.
- `packages/cli/_test/cli-test-helpers.ts` `cliServeArgs` no longer accepts a `configPath` argument (drops `--config <path>` from the argv it constructs); instead `cliEnv` accepts and forwards `AIO_PROXY_HOME`. Every test call site updated.
- `packages/cli/_test/cli.test.ts` and `packages/cli/_test/provider-commands.test.ts` updated to match the new help text, new placeholder names, absence of `--config`, and absence of `--dashboard`.
- Bun test suite passes (`bun test`) with the modified helpers and updated assertions.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- MUST NOT introduce `AIO_PROXY_URL` env, config-derived dashboard URL, or any change to `--url` / `--dashboard-url`. Preserved verbatim in P1.
- MUST NOT add `stop`, `status`, `logs`, `restart`, `service`, or `serve --detach` commands.
- MUST NOT rename `provider test` to `provider probe`.
- MUST NOT split `provider list --installed` into `provider packages`.
- MUST NOT implement the actual `dashboard`, `model list`, `trace list`, or `trace show` behavior. `model`/`trace` remain empty groups; `dashboard` remains an explicit-not-yet-implemented leaf.
- MUST NOT read `XDG_CONFIG_HOME` anywhere in `paths.ts` or in migrated call sites.
- MUST NOT migrate, copy, symlink, or otherwise touch `~/.config/aio-proxy`. Users re-login and re-install once; that outcome is recorded in the changeset the executor writes (see todo 10).
- MUST NOT add a `config path` / `config edit` subcommand or any other new command surface.
- MUST NOT add a global `--json` flag.
- MUST NOT include zh-Hans translations for the new i18n keys — only English source strings; zh-Hans values are `TODO(i18n): <English source>` placeholders. There are no other locale files in this repo (see `packages/i18n/project.inlang/settings.json:3-8`), and P1 MUST NOT create any.
- MUST NOT migrate, copy, symlink, or otherwise touch `~/.config/aio-proxy`. Users re-login and re-install once; that outcome is recorded in the changeset the executor writes (see todo 10).
- MUST NOT touch any file outside these paths: `packages/cli/**` (source + tests + package.json), `packages/core/src/paths.ts` (new), `packages/core/src/index.ts` (add one re-export line for `paths.ts`), `packages/core/src/db/open-db.ts`, `packages/core/src/npm.ts`, `packages/core/src/npm-list.ts`, `packages/core/_test/paths.test.ts` (new), `packages/core/_test/open-db-paths.test.ts` (new or extended existing db test file), `packages/i18n/messages/en.json`, `packages/i18n/messages/zh-Hans.json`, `packages/i18n/src/paraglide/**` (regenerated output only), and `.changeset/cli-redesign.md` (new). Any other touch is scope creep.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: **tests-after per todo** (Bun test framework, already used by the repo). No new test framework introduced. Where behavior is added (serve --open, i18n key resolution, path resolution), a targeted test is added inside the SAME todo as the change.
- Evidence: `.omo/evidence/task-<N>-cli-redesign.<ext>` — every todo dumps command output (stdout+stderr) + exit code from the acceptance run and the QA runs into a `.log` or `.md` file under this path.
- Global gate: `bun test` from repo root must pass in the FINAL wave. Individual todos may run narrower `bun test <path>` invocations during their own execution.

## Execution strategy
### Parallel execution waves

- **Wave A (paths + i18n foundation, parallelizable across 3 todos):** introduce `paths.ts`; scaffold the new i18n keys and rebuild Paraglide output; establish the test-helper env-injection contract.
- **Wave B (call-site migration + CLI surface, parallelizable across 5 todos):** migrate `open-db.ts`, `npm*.ts`, and `packages/cli/src/main.ts` off the old resolvers and onto `paths.ts`; unify placeholders; delete `--config` / `AIO_PROXY_CONFIG`; fix `serve --dashboard` → `--open`; move startup log to stderr; strip `runStub` bindings.
- **Wave C (tests + changeset, parallelizable across 2 todos):** update `packages/cli/_test/*` to the new surface; write the `.changeset/cli-redesign.md` file.
- **Final wave (verification):** run F1–F4 in parallel; only after all four pass does the plan report success.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1. Add `packages/core/src/paths.ts` | — | 4, 5, 6 | 2, 3 |
| 2. Scaffold new i18n keys in `packages/i18n` + regen Paraglide | — | 7, 8 | 1, 3 |
| 3. Contract for test-helper env injection (`cliEnv` forwards `AIO_PROXY_HOME`) | — | 9 | 1, 2 |
| 4. Migrate `packages/core/src/db/open-db.ts` to `paths.ts` | 1 | Final | 5, 6, 7, 8 |
| 5. Migrate `packages/core/src/npm.ts` + `npm-list.ts` to `paths.ts` | 1 | Final | 4, 6, 7, 8 |
| 6. Delete `packages/cli/src/config-path.ts` + `--config` flag + `AIO_PROXY_CONFIG` env + fix `serve:dev` script | 1 | 7, 8, 9, 10 | 4, 5 |
| 7. Unify placeholders + i18n every provider subcommand + every option in `main.ts` and `provider-commands.ts` | 2, 6 | 9 | 4, 5, 8 |
| 8. `serve --dashboard` → `--open` (real wire); move serve startup log to stderr; drop `runStub` bindings (`dashboard` prints i18n not-yet-implemented to stderr with exit 2; `model`/`trace` become empty groups) | 2, 6 | 9 | 4, 5, 7 |
| 9. Update `packages/cli/_test/*` for new help text, placeholders, env-injection, absent `--config`/`--dashboard` | 3, 6, 7, 8 | Final | 10 |
| 10. Changeset entry for the breaking changes (home dir move, flag/env deletion, `--dashboard` → `--open`) | 6, 8 | Final | 9 |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->

- [x] 1. Add single-source path module `packages/core/src/paths.ts`
  What to do / Must NOT do: Create new file exporting `aioHome()`, `configPath()`, `dbPath()`, `packagesDir()`, `pidPath()`, `logPath()`. `aioHome()` treats BOTH `undefined` AND empty string as absent — implement it as: `const home = process.env.AIO_PROXY_HOME; return home === undefined || home === "" ? join(homedir(), ".aio-proxy") : home;`. Do NOT use nullish coalescing (`??`) alone, since `AIO_PROXY_HOME=""` must fall through to the default per todo 1 QA and per todo 4 QA. Export from `packages/core/src/index.ts`. MUST NOT read `XDG_CONFIG_HOME`. MUST NOT support fallback to `~/.config/aio-proxy`. MUST NOT export from any other package.
  Parallelization: Wave A | Blocked by: — | Blocks: 4, 5, 6
  References (executor has NO interview context - be exhaustive): `packages/cli/src/config-path.ts:1-13` (current shape of the config resolver being replaced); `packages/core/src/db/open-db.ts:80-92` (current db path resolver — note it uses `??` and does NOT protect against empty string; our new module intentionally departs from that behavior); `packages/core/src/npm.ts:42-49` (current npm cache dir hardcode); `packages/core/src/npm-list.ts:12-14` (current npm list root hardcode); `packages/core/src/index.ts` (where to add the new export).
  Acceptance criteria (agent-executable):
    - `bun test packages/core/_test/paths.test.ts` passes with tests asserting: (a) `AIO_PROXY_HOME=/tmp/foo` env yields `configPath() === "/tmp/foo/config.jsonc"` and analogous for `dbPath()`, `packagesDir()`, `pidPath()`, `logPath()`; (b) absent env yields `aioHome().endsWith(".aio-proxy")`; (c) `AIO_PROXY_HOME=""` behaves identically to absent env (falls back to `~/.aio-proxy`); (d) all five derived paths end with the correct basenames (`config.jsonc`, `aio-proxy.db`, `packages`, `aio-proxy.pid`, `aio-proxy.log`).
    - `rg -n 'XDG_CONFIG_HOME' packages/core/src/paths.ts` returns empty.
    - `rg -n 'AIO_PROXY_HOME \?\?' packages/core/src/paths.ts` returns empty (confirms nullish-coalescing was NOT used for the home resolution).
  QA scenarios (name the exact tool + invocation):
    - Happy: `AIO_PROXY_HOME=/tmp/aio-p bun -e "import('./packages/core/src/paths.ts').then(m => console.log(m.configPath()))"` prints `/tmp/aio-p/config.jsonc`. Evidence `.omo/evidence/task-1-cli-redesign.log`.
    - Failure: `AIO_PROXY_HOME="" bun -e "import('./packages/core/src/paths.ts').then(m => console.log(m.configPath()))"` prints a path ending with `.aio-proxy/config.jsonc` (proves empty string is treated as absent). Evidence appended to same file.
  Commit: Y | feat(core): add paths.ts as single source of truth for `~/.aio-proxy` layout

- [x] 2. Scaffold new i18n keys in `packages/i18n` (English source + zh-Hans TODO markers) and regenerate Paraglide output
  What to do / Must NOT do:
    - Edit `packages/i18n/messages/en.json`: add the new keys listed below with the English source strings; delete `cli_serve_option_config_description` and `cli_serve_option_dashboard_description`.
    - Edit `packages/i18n/messages/zh-Hans.json`: add the same new keys with values set to `TODO(i18n): <English source>` so the i18n author can find them; delete `cli_serve_option_config_description` and `cli_serve_option_dashboard_description`.
    - After both JSON files are updated, run `bun run --cwd packages/i18n build` so `packages/i18n/src/paraglide/**` is regenerated and the new `m.cli_*` exports actually exist.
    - MUST NOT create any locale file other than the two above (`zh-CN`, `ja`, etc. do not exist in this repo — see `packages/i18n/project.inlang/settings.json:3-8`).
    - MUST NOT translate any new key into zh-Hans; leave the `TODO(i18n): ...` marker as-is.
    - MUST NOT change existing English strings for keys we are keeping (`cli_serve_description`, `cli_dashboard_description`, `cli_provider_description`, `cli_model_description`, `cli_trace_description`, etc.).
  Parallelization: Wave A | Blocked by: — | Blocks: 7, 8
  References (executor has NO interview context - be exhaustive):
    - `packages/i18n/messages/en.json:9-13` — where `cli_serve_option_*` keys currently live; add the new keys in the same block and delete `cli_serve_option_dashboard_description` at line 12 and `cli_serve_option_config_description` at line 13.
    - `packages/i18n/messages/zh-Hans.json:5-9` — the mirror locations in zh-Hans; same additions with `TODO(i18n): ...` values, same deletions.
    - `packages/i18n/project.inlang/settings.json:3-8` — confirms configured locales are only `en` and `zh-Hans`; no other locale file must be created.
    - `packages/i18n/package.json:13-17` — build script is `paraglide-js compile --emit-ts-declarations`; run via `bun run --cwd packages/i18n build` from repo root.
    - New keys to add (identical set of keys in both `en.json` and `zh-Hans.json`; English source below; zh-Hans value is `TODO(i18n): <English source>`):
      - `cli_serve_option_open_description` → "Open the dashboard in the default browser after startup."
      - `cli_provider_install_description` → "Install a runtime provider package."
      - `cli_provider_install_option_yes_description` → "Skip the interactive confirmation."
      - `cli_provider_install_option_registry_description` → "Override the npm registry URL."
      - `cli_provider_login_description` → "Interactive OAuth login for a provider vendor."
      - `cli_provider_login_unknown_vendor` → "Unknown OAuth provider vendor: {vendor}"
      - `cli_provider_list_description` → "List providers reported by the running server."
      - `cli_provider_list_option_filter_description` → "Show only one provider by id."
      - `cli_provider_list_option_probe_description` → "Probe each provider before printing."
      - `cli_provider_list_option_installed_description` → "List runtime provider packages installed on disk." (retained; the split into a separate `packages` command is P3)
      - `cli_provider_list_option_url_description` → "Dashboard URL." (retained verbatim; P3 removes this)
      - `cli_provider_test_description` → "Probe a single provider by id." (retained; rename is P3)
      - `cli_provider_test_option_url_description` → "Dashboard URL." (retained verbatim; P3 removes this)
      - `cli_dashboard_not_yet_implemented` → "The dashboard command is not yet implemented; run `aio-proxy serve --open` to open the dashboard."
    - Keys to DELETE from BOTH `en.json` and `zh-Hans.json`: `cli_serve_option_config_description`, `cli_serve_option_dashboard_description`.
  Acceptance criteria (agent-executable):
    - `rg -n 'cli_serve_option_open_description' packages/i18n/messages` returns hits in BOTH `en.json` and `zh-Hans.json`.
    - `rg -n 'cli_serve_option_config_description|cli_serve_option_dashboard_description' packages/i18n/messages` returns empty.
    - `bun run --cwd packages/i18n build` exits 0 and leaves `packages/i18n/src/paraglide/**` up-to-date (verify with `git status packages/i18n/src/paraglide` — any diff must be committed alongside the JSON changes; NO uncommitted paraglide drift).
    - `bun test packages/i18n` passes.
    - Following one-shot verifier prints "OK" and exits 0; otherwise exits 1:
      ```sh
      bun -e '
        import { m, setLocale } from "./packages/i18n/src/index.ts";
        setLocale("en");
        const keys = [
          "cli_serve_option_open_description",
          "cli_provider_install_description",
          "cli_provider_install_option_yes_description",
          "cli_provider_install_option_registry_description",
          "cli_provider_login_description",
          "cli_provider_login_unknown_vendor",
          "cli_provider_list_description",
          "cli_provider_list_option_filter_description",
          "cli_provider_list_option_probe_description",
          "cli_provider_list_option_installed_description",
          "cli_provider_list_option_url_description",
          "cli_provider_test_description",
          "cli_provider_test_option_url_description",
          "cli_dashboard_not_yet_implemented",
        ];
        const missing = keys.filter((k) => typeof (m)[k] !== "function" || String((m)[k]({ vendor: "x" }) ?? "").length === 0);
        if (missing.length > 0) { console.error("MISSING:", missing.join(", ")); process.exit(1); }
        console.log("OK");
      '
      ```
  QA scenarios (name the exact tool + invocation):
    - Happy: the one-shot verifier command above under `LANG=en_US.UTF-8` — evidence `.omo/evidence/task-2-cli-redesign.log`.
    - Failure: `bun -e 'import { m } from "./packages/i18n/src/index.ts"; console.log(typeof (m).cli_serve_option_config_description);'` prints `undefined`. Evidence appended.
  Commit: Y | chore(i18n): add CLI i18n keys for provider subcommands and options; drop --config and --dashboard keys

- [x] 3. Test-helper contract: `cliEnv` accepts and forwards `AIO_PROXY_HOME`
  What to do / Must NOT do: In `packages/cli/_test/cli-test-helpers.ts`, extend the `CliEnv` type + `cliEnv` builder so callers can pass `AIO_PROXY_HOME`. Update `runCli` / `runCliAsync` signatures if needed to expose it. MUST NOT yet remove `--config` from `cliServeArgs` — that happens in todo 9 after the CLI surface actually drops `--config`. This todo just establishes the injection channel.
  Parallelization: Wave A | Blocked by: — | Blocks: 9
  References (executor has NO interview context - be exhaustive): `packages/cli/_test/cli-test-helpers.ts:6-51` — current `CliEnv`, `cliEnv`, `runCli`, `runCliAsync`, `cliServeArgs` shapes.
  Acceptance criteria (agent-executable):
    - `bun test packages/cli/_test` passes unchanged (this is a pure contract addition; no existing test should break).
    - `rg -n 'AIO_PROXY_HOME' packages/cli/_test/cli-test-helpers.ts` shows the env is forwarded through `cliEnv`.
  QA scenarios (name the exact tool + invocation):
    - Happy: a one-off scratch test (`packages/cli/_test/env-injection.smoke.test.ts` — delete after) confirms that `runCliAsync(["--help"], { AIO_PROXY_HOME: "/tmp/x" })` doesn't crash and the env var is present. Evidence `.omo/evidence/task-3-cli-redesign.log`.
    - Failure: unknown env keys are ignored, not injected as flags. Evidence appended.
  Commit: N (folded into todo 9's commit to keep history atomic)

- [x] 4. Migrate `packages/core/src/db/open-db.ts` off its private resolver onto `paths.ts`
  What to do / Must NOT do: Replace `resolveDbPath()` and `defaultHomeDir()` implementations with a single call to `dbPath()` from `paths.ts`. Delete the `ENV_XDG_CONFIG_HOME` constant and the XDG branch. Keep `OpenDbOptions.home` as exported API surface for local test isolation; when `options.home` is set, use `resolve(options.home, "aio-proxy.db")`; otherwise `dbPath()`. Add a new focused test (`packages/core/_test/open-db-paths.test.ts` — or extend an existing db test file if one exists) that calls `openDb({ home: tmpdir })` and asserts the DB is created at `<tmpdir>/aio-proxy.db`, since existing OAuth store tests do not exercise this branch and the migration would otherwise be untested. MUST NOT change the SQLite pragma / migration behavior.
  Parallelization: Wave B | Blocked by: 1 | Blocks: Final
  References (executor has NO interview context - be exhaustive): `packages/core/src/db/open-db.ts:1-92` (current implementation); `packages/core/src/db/open-db.ts:81-83` `resolveDbPath` (the specific function being simplified); `packages/oauth/_test/store.test.ts` (heaviest caller — check that removing the XDG branch does not break it, but note it does NOT itself pass `options.home`, so a new dedicated test is required for that branch).
  Acceptance criteria (agent-executable):
    - `bun test packages/oauth/_test/store.test.ts` passes.
    - `bun test packages/core` passes and includes the new `openDb({ home: tmpdir })` test.
    - `rg -n 'XDG_CONFIG_HOME' packages/core` returns empty (0 hits).
    - `rg -n '"\.config"' packages/core/src` returns empty (0 hits — no more hardcoded `.config` in source; tests may still reference historical paths).
  QA scenarios (name the exact tool + invocation):
    - Happy: `AIO_PROXY_HOME=$(mktemp -d) bun test packages/oauth/_test/store.test.ts`; then verify DB file exists at `$AIO_PROXY_HOME/aio-proxy.db`. Evidence `.omo/evidence/task-4-cli-redesign.log`.
    - Failure: `AIO_PROXY_HOME="" bun -e 'import { openDb } from "./packages/core/src/db"; const h = openDb(); console.log(h.path); h.close();'` prints a path ending with `/.aio-proxy/aio-proxy.db` (empty-string env falls through to default). Evidence appended.
  Commit: Y | refactor(core): route db path through paths.ts, drop XDG + ~/.config fallback

- [x] 5. Migrate `packages/core/src/npm.ts` + `packages/core/src/npm-list.ts` to `paths.ts`
  What to do / Must NOT do: Replace the two `join(homedir(), ".config", "aio-proxy", "cache", "packages", ...)` hardcodes with `join(packagesDir(), encodeURIComponent(pkg))` (in `npm.ts`) and `packagesDir()` (in `npm-list.ts`). MUST NOT change `encodeURIComponent` behavior or the `packageNameParts` validation. MUST NOT rename the on-disk directory shape beyond dropping the `cache/packages` prefix (new: `~/.aio-proxy/packages/<encoded>/...`; old: `~/.config/aio-proxy/cache/packages/<encoded>/...`).
  Parallelization: Wave B | Blocked by: 1 | Blocks: Final
  References (executor has NO interview context - be exhaustive): `packages/core/src/npm.ts:42-49` (`npmPackageCacheDir`); `packages/core/src/npm-list.ts:12-14` (`listInstalledNpmPackages` root); `packages/core/_test/npm.test.ts` (test coverage — assertions may compare exact paths and need updating).
  Acceptance criteria (agent-executable):
    - `bun test packages/core/_test/npm.test.ts` passes.
    - `rg -n '"\.config"' packages/core/src/npm.ts packages/core/src/npm-list.ts` returns empty.
    - `rg -n 'homedir\(\)' packages/core/src/npm.ts packages/core/src/npm-list.ts` returns empty (paths.ts owns homedir).
  QA scenarios (name the exact tool + invocation):
    - Happy: `AIO_PROXY_HOME=/tmp/aio-p bun test packages/core/_test/npm.test.ts`; verify installed packages materialize under `/tmp/aio-p/packages/`. Evidence `.omo/evidence/task-5-cli-redesign.log`.
    - Failure: run without env; verify packages land in `~/.aio-proxy/packages/`. Evidence appended.
  Commit: Y | refactor(core): route npm cache through paths.ts, flatten to ~/.aio-proxy/packages

- [x] 6. Delete `packages/cli/src/config-path.ts`, drop `--config` flag from all commands, drop `AIO_PROXY_CONFIG` env, fix `serve:dev` script
  What to do / Must NOT do: (a) Delete `packages/cli/src/config-path.ts` entirely. (b) Replace every `resolveConfigPath(options.config)` call site with `configPath()` from `paths.ts`. (c) Remove the `--config <path>` option registration from `serve` and `provider login` in `packages/cli/src/main.ts:147,166`. (d) Remove the `config` field from `ServeOptions` and `ProviderLoginOptions`. (e) Ensure `AIO_PROXY_CONFIG` is not read anywhere. (f) Rewrite the `serve:dev` script in `packages/cli/package.json:13` from `"bun src/main.ts serve --config ../../aio-proxy.json"` to `"AIO_PROXY_HOME=../../ bun src/main.ts serve"` (or equivalent env-based invocation that points at the repo-root fixture). MUST NOT delete or rename `AIO_PROXY_HOME`. MUST NOT touch anything about `--url` / dashboard URL. This todo is the destructive core; keep the diff surgical.
  Parallelization: Wave B | Blocked by: 1 | Blocks: 7, 8, 9, 10
  References (executor has NO interview context - be exhaustive): `packages/cli/src/config-path.ts:1-13`; `packages/cli/src/main.ts:107-130` (`serve` handler currently calls `resolveConfigPath(options.config)`); `packages/cli/src/main.ts:141-148` (serve options registration includes `--config`); `packages/cli/src/main.ts:164-167` (provider login option registration includes `--config`); `packages/cli/src/provider-commands.ts:78` (`resolveConfigPath(options.config)` call in `providerLogin`); `packages/cli/src/provider-commands.ts:37-39` (`ProviderLoginOptions` type); `packages/cli/package.json:13` (existing `serve:dev` script that references `--config`); `packages/cli/_test/cli-test-helpers.ts:44-51` (existing `cliServeArgs` that passes `--config`; the test-side deletion happens in todo 9).
  Acceptance criteria (agent-executable):
    - `rg -n 'resolveConfigPath' packages` returns empty (function is gone).
    - `rg -n '"--config"' packages/cli` returns empty (both `src/` and `package.json`).
    - `rg -n 'AIO_PROXY_CONFIG' packages` returns empty.
    - `bun run packages/cli/src/main.ts serve --help` help text does NOT contain `--config`.
    - `rg -n -- '--config' packages/cli/package.json` returns empty.
    - `bun test packages/cli` may fail for tests that still reference `--config` — those are updated in todo 9. This todo does NOT touch tests.
  QA scenarios (name the exact tool + invocation):
    - Happy: `AIO_PROXY_HOME=/tmp/aio-p bun run packages/cli/src/main.ts serve --port 22078` starts and reads `/tmp/aio-p/config.jsonc`. Evidence `.omo/evidence/task-6-cli-redesign.log`.
    - Failure: `AIO_PROXY_CONFIG=/tmp/other.jsonc bun run packages/cli/src/main.ts serve` MUST NOT honor the env var; it uses `~/.aio-proxy/config.jsonc` (or `AIO_PROXY_HOME`). Evidence appended.
  Commit: Y | feat(cli)!: replace --config flag and AIO_PROXY_CONFIG env with AIO_PROXY_HOME (breaking)

- [x] 7. Unify argument placeholders and i18n every provider subcommand + every option
  What to do / Must NOT do: In `packages/cli/src/main.ts:141-172`, rewrite all commander registrations so: (a) `install <pkg>` → `install <package>`; (b) `login <family>` → `login <vendor>`; (c) argument occurrences of `<id>` clarify as `<provider-id>`; (d) every `.description(...)` call reads from `m.cli_*_description()`; (e) every `.option(...)` third argument (help text) reads from `m.cli_*_description()`. In `packages/cli/src/provider-commands.ts:65-87`, extend `providerLogin(family, ...)` — rename the parameter to `vendor` and normalize both short forms (`copilot`, `chatgpt`) and long forms (`github-copilot`, `openai-chatgpt`) to the same underlying flow; error message on unknown vendor also flows through i18n (add key `cli_provider_login_unknown_vendor` if not already present). MUST NOT rename `provider test` to `provider probe`. MUST NOT touch `--url` / `--installed`. MUST NOT change the persisted `config.providers[*].vendor` shape.
  Parallelization: Wave B | Blocked by: 2, 6 | Blocks: 9
  References (executor has NO interview context - be exhaustive): `packages/cli/src/main.ts:134-173` (whole `buildProgram()`); `packages/cli/src/provider-commands.ts:55-87` (install + login); the new i18n keys added in todo 2; `packages/cli/src/provider-commands.ts:66-71` (current short-form vendor detection); `packages/cli/src/provider-commands.ts:83` (long-form vendor written to config).
  Acceptance criteria (agent-executable):
    - `bun run packages/cli/src/main.ts provider install --help` shows placeholder `<package>` and i18n descriptions for `--yes` / `--registry`.
    - `bun run packages/cli/src/main.ts provider login --help` shows placeholder `<vendor>`.
    - `rg -n '"Confirm runtime package installation\."' packages/cli/src` returns empty (hardcoded English gone).
    - `rg -n '"Registry URL\."' packages/cli/src` returns empty.
    - `rg -n '"Dashboard URL\."' packages/cli/src` returns empty (this is retained i18n key; text moved to i18n file per todo 2's `cli_provider_list_option_url_description`).
    - `rg -n '"Only list one provider id\."' packages/cli/src` returns empty.
    - `bun run packages/cli/src/main.ts provider login github-copilot` behaves identically to `... login copilot` (uses `AIO_PROXY_TEST_COPILOT_LOGIN` for scripted test).
  QA scenarios (name the exact tool + invocation):
    - Happy: `AIO_PROXY_TEST_COPILOT_LOGIN='{"providerId":"gh-copilot-1","payload":{}}' AIO_PROXY_HOME=/tmp/aio-p bun run packages/cli/src/main.ts provider login github-copilot`; verify persisted config uses `vendor: "github-copilot"`. Repeat with `... login copilot`; same result. Evidence `.omo/evidence/task-7-cli-redesign.log`.
    - Failure: `... provider login unknown-vendor` prints an i18n error and exits 1. Evidence appended.
  Commit: Y | feat(cli)!: unify placeholder names and i18n every provider subcommand and option

- [x] 8. Fix `serve --dashboard` → `--open`, move serve startup log to stderr, strip `runStub` bindings
  What to do / Must NOT do: (a) Rename the `serve` option `--dashboard` to `--open` in `packages/cli/src/main.ts:146`; update `ServeOptions.dashboard` to `ServeOptions.open`. (b) In the `serve` handler (`main.ts:107-130`), after `Bun.serve(...)`, if `options.open === true`, call `openBrowser(dashboardUrl)` — extract `openBrowser` from `packages/cli/src/provider-commands.ts:206-220` to a new shared module `packages/cli/src/browser.ts` and import it from both call sites; MUST NOT copy-paste. (c) Move the `console.log(m.cli_serve_started(...))` call at `main.ts:124-129` to `console.error(...)`. (d) Delete `runStub` and its three bindings. (e) `program.command("model")` and `program.command("trace")` become groups WITHOUT `.action()` (commander then prints group help). (f) `program.command("dashboard").description(...).action(...)` — the action prints `m.cli_dashboard_not_yet_implemented()` to stderr and sets `process.exitCode = 2`. MUST NOT implement actual browser-opening for `dashboard` in P1. MUST NOT wire `model`/`trace` to anything. MUST NOT add any global `--json` flag anywhere.
  Parallelization: Wave B | Blocked by: 2, 6 | Blocks: 9
  References (executor has NO interview context - be exhaustive): `packages/cli/src/main.ts:107-130` (serve handler with `apiUrl` and `dashboardUrl` already computed); `packages/cli/src/main.ts:132` (`runStub` declaration to delete); `packages/cli/src/main.ts:141-148` (serve options where `--dashboard` lives); `packages/cli/src/main.ts:150,169-170` (stub-command registrations to rewrite); `packages/cli/src/provider-commands.ts:206-220` (`openBrowser` implementation to extract); the new i18n key `cli_dashboard_not_yet_implemented` produced by todo 2.
  Acceptance criteria (agent-executable):
    - `bun run packages/cli/src/main.ts serve --help` shows `--open`, does NOT show `--dashboard`.
    - `bun run packages/cli/src/main.ts model` prints commander's group help (usage line + no subcommands listed). Exit code 0.
    - `bun run packages/cli/src/main.ts trace` same behavior.
    - `bun run packages/cli/src/main.ts dashboard` prints the i18n not-yet-implemented message on **stderr**, exit code 2. Verify with: `bun run packages/cli/src/main.ts dashboard 2>&1 >/dev/null | grep -q "not yet implemented"; echo "stderr-ok=$?"`.
    - `AIO_PROXY_HOME=$(mktemp -d) bun run packages/cli/src/main.ts serve --port <freeport> </dev/null >/tmp/serve.out 2>/tmp/serve.err &`; kill after 1s; then `test ! -s /tmp/serve.out && grep -q "AIO Proxy listening" /tmp/serve.err` (proves startup line moved to stderr).
    - `rg -n 'runStub' packages/cli/src` returns empty.
    - `test -f packages/cli/src/browser.ts` (the extracted module exists).
  QA scenarios (name the exact tool + invocation):
    - Happy: temporarily prepend a fake platform opener to `PATH` — create `/tmp/aio-p-bin/open` (darwin), `/tmp/aio-p-bin/xdg-open` (linux), or `/tmp/aio-p-bin/cmd` (win32) as a shell script that appends its argv to `/tmp/aio-p-opener.log`; then `PATH=/tmp/aio-p-bin:$PATH AIO_PROXY_HOME=$(mktemp -d) bun run packages/cli/src/main.ts serve --port <freeport> --open </dev/null &`; poll `/tmp/aio-p-opener.log` for the dashboard URL (contains `/dashboard`) within 3s; kill the server. Evidence `.omo/evidence/task-8-cli-redesign.log`.
    - Failure: `bun run packages/cli/src/main.ts dashboard` prints the not-yet-implemented message on stderr and exits 2 (no `--json` flag involved anywhere). Evidence appended.
  Commit: Y | feat(cli)!: rename serve --dashboard to --open with real browser open; log to stderr

- [x] 9. Update `packages/cli/_test/*` for the new CLI surface
  What to do / Must NOT do: (a) `packages/cli/_test/cli-test-helpers.ts:44-51` — remove the `configPath` parameter from `cliServeArgs`; drop the `"--config", configPath` pair from the argv it constructs. (b) Every caller of `cliServeArgs` — switch to passing `AIO_PROXY_HOME` through `cliEnv`. (c) `packages/cli/_test/cli.test.ts` — update `--help` assertions to expect `<package>` / `<vendor>` / `<provider-id>` and to NOT expect `--config` / `--dashboard`; add assertion that `dashboard` command prints not-yet-implemented on stderr exit 2. (d) `packages/cli/_test/provider-commands.test.ts` — update any assertions referencing `<pkg>` / `<family>` / `<id>` argument names; update `providerLogin` tests to also cover the long-form `github-copilot` / `openai-chatgpt` inputs. MUST NOT add tests for behavior deferred to P2/P3 (no daemon, no probe rename, no URL discovery).
  Parallelization: Wave C | Blocked by: 3, 6, 7, 8 | Blocks: Final
  References (executor has NO interview context - be exhaustive): `packages/cli/_test/cli-test-helpers.ts:1-91` (full helpers file); `packages/cli/_test/cli.test.ts` (help + top-level command assertions); `packages/cli/_test/provider-commands.test.ts` (install/login/list/test coverage).
  Acceptance criteria (agent-executable):
    - `bun test packages/cli` passes with zero skipped and zero failing tests.
    - `rg -n 'cliServeArgs\([^,]*config' packages/cli/_test` returns empty (no call passes a configPath).
    - `rg -n '"--config"' packages/cli/_test` returns empty.
  QA scenarios (name the exact tool + invocation):
    - Happy: `bun test packages/cli/_test/cli.test.ts` — evidence `.omo/evidence/task-9-cli-redesign.log`.
    - Failure: `bun test packages/cli/_test/provider-commands.test.ts` under `LANG=en_US.UTF-8` — verify i18n descriptions render in English. Evidence appended.
  Commit: Y | test(cli): align CLI tests with placeholder + i18n + AIO_PROXY_HOME rework

- [x] 10. Changeset entry for the breaking changes
  What to do / Must NOT do: Add ONE new file `.changeset/cli-redesign.md` with the EXACT front matter and body below. The `fixed` group `["aio-proxy", "@aio-proxy/*"]` in `.changeset/config.json:8` means bumping `@aio-proxy/cli` as `major` will pull the entire family to a new major — this is intentional. MUST NOT modify `.changeset/config.json` or `.changeset/README.md`. MUST NOT list `probe`/`packages`/`daemon`/`--json`/`AIO_PROXY_URL` — those are future phases.

  Required file content for `.changeset/cli-redesign.md`:
  ```md
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
  ```

  Parallelization: Wave C | Blocked by: 6, 8 | Blocks: Final
  References (executor has NO interview context - be exhaustive):
    - `.changeset/README.md:1-5` (repo convention: changesets drive npm publish; fixed group ties packages together);
    - `.changeset/config.json:8` (`"fixed": [["aio-proxy", "@aio-proxy/*"]]` — a `major` on `@aio-proxy/cli` pulls the entire family);
    - `packages/cli/package.json:2` (`"name": "@aio-proxy/cli"` — exact package name to use in the changeset front matter).
  Acceptance criteria (agent-executable):
    - `test -f .changeset/cli-redesign.md`.
    - `head -3 .changeset/cli-redesign.md | grep -qE '^"@aio-proxy/cli": major$'`.
    - `rg -n 'AIO_PROXY_URL|provider probe|provider packages|--json|serve --detach|"stop"|"status"|"logs"' .changeset/cli-redesign.md` returns empty.
    - `bunx changeset status --since=main` (or repo equivalent) recognizes the new changeset without errors.
  QA scenarios (name the exact tool + invocation):
    - Happy: `bunx changeset status --since=main` — evidence `.omo/evidence/task-10-cli-redesign.log`.
    - Failure: `rg -n 'AIO_PROXY_URL|provider probe|provider packages|--json|serve --detach|"stop"|"status"|"logs"' .changeset/cli-redesign.md` MUST return empty (proves no future-phase leakage into the announcement). Evidence appended.
  Commit: Y | docs(changeset): announce CLI home-dir move and --config → AIO_PROXY_HOME migration

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit — Momus reviews the diff against this plan's Must-have / Must-NOT-have (including the `.changeset/cli-redesign.md` addition in the allowed-touch whitelist); approves or lists deltas. Evidence `.omo/evidence/task-F1-cli-redesign.md`.
- [x] F2. Code quality review — Oracle reviews the diff for typing, error paths, i18n coverage completeness, dead code (leftover `runStub`, stray `.config` literal, unused i18n keys), and Paraglide freshness (`bun run --cwd packages/i18n build` leaves `packages/i18n/src/paraglide/**` with no uncommitted diff — check via `git status packages/i18n/src/paraglide`). Evidence `.omo/evidence/task-F2-cli-redesign.md`.
- [x] F3. Real manual QA — a fresh shell with `AIO_PROXY_HOME=$(mktemp -d /tmp/aio-p-qa.XXXXXX)`. For the install step, use the public tiny package `is-number@7.0.0` (no dependencies, ~200 bytes) against the real npm registry — this is a one-shot smoke test, not a fixture-heavy install path (which is already covered by `packages/core/_test/npm.test.ts`):
  (a) `bun run packages/cli/src/main.ts provider install is-number --yes --registry https://registry.npmjs.org` → verify `$AIO_PROXY_HOME/packages/is-number/node_modules/is-number/package.json` exists;
  (b) `bun run packages/cli/src/main.ts serve --port <freeport> --open` with a fake platform opener on `PATH` (per todo 8 QA setup) → verify browser opener log recorded the dashboard URL AND startup log lands on stderr only (empty stdout);
  (c) `bun run packages/cli/src/main.ts provider list` against the running server;
  (d) `bun run packages/cli/src/main.ts serve --help` shows no `--config` and no `--dashboard`;
  (e) `bun run packages/cli/src/main.ts dashboard` exits 2 to stderr;
  (f) `bun run packages/cli/src/main.ts model` and `... trace` each exit 0 and print commander group help.
  Evidence `.omo/evidence/task-F3-cli-redesign.md` with each step's stdout/stderr/exit dumped.
- [x] F4. Scope fidelity — restrict the grep to the P1 diff via `git diff --name-only origin/main...HEAD` and confirm: (1) no file outside the whitelist in Must-NOT-have is touched; (2) `git diff origin/main...HEAD -- packages` piped through `rg -n 'AIO_PROXY_URL|provider probe|provider packages|"stop"|"status"|"logs"|serve --detach|"--json"|XDG_CONFIG_HOME'` returns empty (proves no P2/P3/P4 leaked in). Do NOT grep historical docs — only the current diff. Evidence `.omo/evidence/task-F4-cli-redesign.md`.

## Commit strategy

- One commit per breaking-behavior todo (4, 5, 6, 7, 8, 10), one per test alignment todo (9), and one per foundation todo (1, 2). Todo 3 folds into todo 9 (no separate commit) because it is a helper contract without observable behavior on its own.
- Commit types follow Conventional Commits, with `!` on the breaking ones (todos 6, 7, 8).
- Suggested order matches the wave order: A → B → C. Executor may reorder commits within a wave; MUST NOT interleave across waves.

## Success criteria

- Every `[ ]` in Todos is `[x]` and its evidence file exists.
- All four final-wave items report APPROVE.
- `bun test` at repo root passes with zero failures.
- Manual QA (F3) shows: `~/.aio-proxy/` (or the `AIO_PROXY_HOME` override) is the sole active home dir; `provider install` populates `~/.aio-proxy/packages/`; `serve --open` opens the dashboard and logs to stderr only; `--config` / `--dashboard` are gone from `--help`; `dashboard` command exits 2 to stderr; `model` / `trace` groups print commander group help.
- No file outside the whitelisted paths (see Must NOT have) is modified.
- User has explicitly approved plan completion (`$start-work` finished with F1–F4 green, then user says the work is accepted).
