# Task 7 Report: Split CLI Plugin Commands and Colocate Tests

## Status

Implemented and verified against starting commit
`024fadf55bd852e72230574bfbe2661389cb239a`.

The Task 7 brief was corrected to describe the actual provider-login public
contract: the existing provider-login error classes plus
`isProviderLoginUserError` and its private safe-error provenance behavior. The
repository has no `providerLoginErrors` export, so none was invented.

## Delivered

- Replaced the four plugin-command monoliths with responsibility-focused
  directories while preserving imports through `plugin`, `provider-login`,
  `loopback`, and `form`.
- Split plugin lifecycle behavior into errors, config-entry handling,
  descriptor staging/compensation, dependency construction, add, configure,
  remove/list/prune, and a public barrel.
- Split provider login into capability selection, dependencies, safe
  presentation/provenance, errors, and orchestration.
- Split loopback callback parsing/errors from listener lifecycle, and split
  form JSON/error helpers from prompt traversal.
- Deleted the four legacy `_test` monoliths and recreated their coverage in the
  exact 13 required colocated test files, with one directory-local
  `test-support.ts` per command directory.
- Preserved confirmation and prompt behavior, descriptor isolation, inert JSON
  boundaries, config/secret compensation, uncertain commits, lock-release
  failures, provider-login safe rendering, and loopback user-error
  classification.

## TDD Evidence

### Baseline

The literal baseline command inherited a developer database whose schema was
newer than the checked-out compiled Core and therefore failed during suite
loading with `DatabaseSchemaTooNewError` (schema 6 versus compiled schema 1).
Running the same four legacy files with a temporary isolated `AIO_PROXY_HOME`
passed:

```text
121 pass
0 fail
318 expect() calls
4 files
```

### Structural RED

After removing the monolith tests and adding the required colocated test
skeletons before their local support modules existed:

```text
0 pass
13 fail
13 errors
```

All failures were the expected missing directory-local `test-support` imports.

### GREEN

```sh
rtk proxy sh -c 'home=$(mktemp -d); trap '\''rm -rf "$home"'\'' EXIT; AIO_PROXY_HOME="$home" bun test packages/cli/src/plugin-commands/plugin packages/cli/src/plugin-commands/provider-login packages/cli/src/plugin-commands/loopback packages/cli/src/plugin-commands/form'
```

```text
121 pass
0 fail
318 expect() calls
13 files
```

This exactly preserves the baseline test and assertion totals.

The literal non-isolated colocated command again reached the stale developer
database after 114 passing tests and failed between tests for the same schema
mismatch. No Task 7 assertion failed; the isolated run above is the clean
comparison.

## Required Verification

```text
Isolated `bun run --filter @aio-proxy/cli test:unit`
PASS: 147 tests, 0 failures, 420 assertions, 20 files.

`bun run --filter @aio-proxy/cli build:binary`
PASS: darwin-arm64, darwin-x64, linux-arm64, and linux-x64 binaries built.

`bun run build`
PASS: Turbo 7 successful / 7 total.

`bun run check`
PASS: exit 0. Biome reported only 3 warnings and 57 informational diagnostics
outside the Task 7 files; there were no check errors.

`git diff --check`
PASS: exit 0, no output.
```

Binary smoke verification used an isolated home:

```text
aio-proxy --version -> 0.0.0
aio-proxy plugin --help -> add, list, config, remove, and prune commands present
```

## Structural Audits

- All changed handwritten source and test files are at most 300 lines.
- Largest files after formatting:
  - `plugin/configure.test.ts`: 288 lines
  - `plugin/descriptor-security.test.ts`: 284 lines
  - `plugin/remove.test.ts`: 284 lines
  - `loopback/server.test.ts`: 269 lines
- The four legacy test files are absent.
- All 13 required colocated test files exist.
- Existing imports from CLI production code and remaining tests still target
  the unchanged four directory entry paths.
- Public export audit against the starting monoliths confirmed preservation of
  plugin commands/options/dependencies/errors/helpers,
  `isProviderLoginUserError`, provider-login commands/options/dependencies/error
  classes, loopback errors/classification/runner, and form public types/errors/
  `cloneInertJson`/`renderConfigSpec`.
- Build and test commands produced no tracked generated-file changes.

## Files Changed

- Corrected `.superpowers/sdd/task-7-brief.md` and replaced this report.
- Deleted:
  - `packages/cli/src/plugin-commands/{plugin,provider-login,loopback,form}.ts`
  - `packages/cli/_test/plugin-commands.test.ts`
  - `packages/cli/_test/provider-plugin-login.test.ts`
  - `packages/cli/_test/plugin-authorization.test.ts`
  - `packages/cli/_test/plugin-form.test.ts`
- Added the planned production modules and colocated tests under:
  - `packages/cli/src/plugin-commands/plugin/`
  - `packages/cli/src/plugin-commands/provider-login/`
  - `packages/cli/src/plugin-commands/loopback/`
  - `packages/cli/src/plugin-commands/form/`

## Self-review

### Standards axis

No findings. The split follows the repository's responsibility-based file
rules, all handwritten files remain below 300 lines, tests are colocated, and
shared fixtures remain directory-local. No generic repository-wide utility or
new dependency was introduced. Biome passes for every Task 7 file.

### Spec axis

No findings. Each requested module and exact test file exists, legacy files are
removed, the four import surfaces and existing error contracts remain intact,
the binary compiles, and clean-environment test/assertion totals match the
baseline exactly.

The two-axis review was performed manually because the repository's review
workflow normally delegates the axes to sub-agents, while this task explicitly
disallowed spawning sub-agents.

## Concerns

- The default local `AIO_PROXY_HOME` currently contains database schema version
  6 while the checked-out compiled Core expects version 1. Any verification
  that initializes server state must use a clean temporary home until that
  developer environment is upgraded or isolated. This is external to the Task
  7 diff and is reproducible before and after the refactor.
- `.superpowers/sdd/task-4-report.md` was already modified before this task. It
  was not edited or staged.
