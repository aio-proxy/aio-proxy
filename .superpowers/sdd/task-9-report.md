# Task 9 Report: Split the GitHub Copilot Adapter and Tests

Base: `dd43a962bb925b497cf494739a218f7da6286b16`

## Baseline

- Command: `rtk bun run --filter @aio-proxy/plugin-github-copilot test:unit`
- Result: PASS — 20 tests, 0 failures, 72 expectations, 2 files.
- Existing package layout matched the brief: one 305-line `src/github-api.ts`, descriptor construction in the 146-line `src/index.ts`, and one 523-line `_test/github-copilot.test.ts`.
- `.codegraph/` was absent, so normal repository search was used.
- The pre-existing modification to `.superpowers/sdd/task-4-report.md` was not touched or staged.

## RED

- Moved the real tests into `src/plugin.test.ts` and `src/github-api/{login,credential,catalog,urls}.test.ts` before creating the production seams.
- Command: `rtk bun run --filter @aio-proxy/plugin-github-copilot test:unit`
- Result: expected failure — 18 tests passed; 1 failure / 1 module-resolution error; 66 expectations; 19 tests across 6 files.
- Expected error: `Cannot find module './plugin' .../src/plugin.test.ts`.
- The four new GitHub API concern tests passed against the untouched monolith during RED.

## GREEN

- Focused command: `rtk bun test packages/plugins/github-copilot/src/plugin.test.ts packages/plugins/github-copilot/src/github-api/login.test.ts packages/plugins/github-copilot/src/github-api/credential.test.ts packages/plugins/github-copilot/src/github-api/catalog.test.ts packages/plugins/github-copilot/src/github-api/urls.test.ts`
- Result: PASS — 19 tests, 0 failures, 42 expectations, 5 files.
- Final package command: `rtk bun run --filter @aio-proxy/plugin-github-copilot test:unit`
- Final package result: PASS — 26 tests, 0 failures, 82 expectations, 6 files.
- Runtime coverage remained in `_test/runtime.test.ts`; its 5 raw/model runtime behaviors passed unchanged while its duplicated credential/fetch fixtures moved to shared support.

## Build, Check, and Integration

- `rtk bun run --filter @aio-proxy/plugin-github-copilot build`: PASS — Rslib generated 11 modules and declarations.
- `rtk bunx biome check packages/plugins/github-copilot`: PASS — 21 files checked, no diagnostics.
- `rtk bun run check`: PASS — 604 files checked; 0 errors, with 3 pre-existing warnings and 61 pre-existing informational diagnostics outside Task 9.
- `rtk bun test packages/core/_test/plugins/builtins.test.ts`: PASS — 2 tests, 0 failures, 9 expectations.
- `rtk git diff --check`: PASS.
- No dependency, test runner, package export-map, or `private: true` change was made.
- Colocated `*.test.ts` files are excluded from declaration generation through the same `tsconfig.json` pattern used by the OpenAI ChatGPT plugin.
- Built output contains the split production modules and no test modules.

## Line Audit

Command: `rtk proxy sh -c 'find packages/plugins/github-copilot/src -name "*.ts" -exec wc -l {} +'`

All handwritten production and test files are below 300 lines. Largest changed files:

- `src/github-api/login.test.ts`: 220
- `src/plugin.test.ts`: 187
- `src/plugin.ts`: 147
- `src/github-api/login.ts`: 139
- `src/github-api/catalog.test.ts`: 73
- `src/github-api/credential.test.ts`: 48

The complete `src` tree is 1,209 lines across 16 TypeScript files. The genuinely shared package-local test support is 47 lines.

## Diff Audit

Command: `rtk proxy git diff dd43a96 --stat -- packages/plugins/github-copilot`

- 19 files changed, 1,072 insertions, 1,000 deletions.
- Removed: `_test/github-copilot.test.ts`, `src/github-api.ts`.
- Added the seven requested `github-api/` production files, `src/plugin.ts`, and the five requested colocated test files.
- Added `_test/test-support.ts` for `loginContext` (2 callers), `credentialPort` (3 callers), and `withFetchMock` (5 callers); `_test/runtime.test.ts` now reuses it.
- Modified `src/index.ts` and `tsconfig.json` beyond those replacements.
- No Task 4 file is included in the Task 9 diff.

## Self-review

- Standards review found duplicated fetch-mock setup across five files; it was replaced with package-local `_test/test-support.ts` used by all five callers.
- Follow-up review required plugin-owned schema/policy assertions to remain in `plugin.test.ts`; the invalid Enterprise schema case and TTL descriptor case now live there, while `github-api/login.test.ts` and `github-api/catalog.test.ts` exercise only their modules.
- `COPILOT_CATALOG_TTL_MS` is defined once in `github-api/catalog.ts`, consumed by `plugin.ts`, and re-exported as the same binding from the package index.
- The shared support module exports only three genuinely shared fixtures: `loginContext`, `credentialPort`, and `withFetchMock`. The single-use adapter extraction remains private to `plugin.test.ts`.
- Follow-up package tests, build, package check, full check, built-in integration test, line audit, export audit, and diff check all passed.

## Export and Packaging Audit

Runtime root exports after the split:

- `default`
- `createGitHubCopilotPlugin`
- `GITHUB_COPILOT_PLUGIN_VERSION`
- `COPILOT_CATALOG_TTL_MS`
- `englishPresentationText`

The public default descriptor and plugin factory remain. The requested presentation rename is reflected in both value and type exports:

- `englishCopy` -> `englishPresentationText`
- `GitHubCopilotCopy` -> `GitHubCopilotPresentationText`

Root type exports `GitHubAccountOptions` and `GitHubCopilotCredential` remain.

`src/github-api/index.ts` exports only the preserved public API:

- `loginToGitHubCopilot`
- `discoverGitHubCopilotModels`
- `currentGitHubCopilotCredential`
- `fetchCopilotToken`
- `normalizeEnterpriseURL`
- `getGitHubCopilotBaseURL`
- `githubApiBase`
- `copilotHeaders`
- `GitHubAccountOptions` and `GitHubCopilotCredential` types

Request parsing, auth headers, device polling, GitHub user lookup, token expiry, refresh behavior, model descriptors/protocol mapping, enterprise URL handling, catalog TTL, raw/model runtime behavior, and existing error strings remain unchanged.
