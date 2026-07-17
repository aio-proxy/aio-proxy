# Final Whole-Branch Review Fixes Report

Base and branch:

- Branch: `codex/oauth-plugin-system-design`
- Starting commit: `f5aa7084d8726644d0cf963f894511b8952efe4f`
- Scope: all findings in `.superpowers/sdd/final-review-fixes-brief.md`

## Implemented fixes

1. Fixed-port OAuth bind failures now offer manual-only fallback only when the request is interactive, fixed-port, and allows manual callback entry. Acceptance keeps the requested redirect URI and runs without a listener; rejection and confirmation errors retain `LoopbackPortUnavailableError`; abort still wins classification.
2. Core and i18n build assertions moved from ordinary `*.test.ts` discovery to explicit `test:artifact` smoke files. Root `preflight` now runs build before artifact smoke. Two Core self-package test imports now target source so Core unit tests do not require its own `dist`.
3. Added one defensive `collectSecretStrings` traversal beside `redactPluginError` and reused it in loader, login/catalog, and credential refresh redaction. It globally deduplicates object references and strings, ignores empty strings, traverses arrays, stops cycles, skips individual hostile properties, contains `ownKeys` failures, and never throws. The collector remains internal to Core by excluding it from the public plugin barrel.
4. Descriptor-like objects with an unsupported integer `apiVersion` now report `PLUGIN_API_INCOMPATIBLE` independently of descriptor brand.
5. Dashboard plugin metadata now uses public `resolveLocalizedText` from `@aio-proxy/plugin-sdk`; the local resolver copy was deleted.
6. `COPILOT_CATALOG_TTL_MS` is re-exported by `github-api/index.ts`; all imports outside that directory use the entry point.
7. `ProvidersPage` now owns query/page assembly (71 lines), while `ProvidersTable` owns provider column definitions, formatting, table state, actions, and delete dialog (188 lines).

## TDD and focused verification

| Area | RED command/result | GREEN command/result |
| --- | --- | --- |
| Fixed-port manual-only fallback | `rtk bun test --preload=./packages/cli/_test/setup.ts packages/cli/src/plugin-commands/loopback/server.test.ts` → 11 pass, 2 fail, 34 expects | same command → 13 pass, 0 fail, 39 expects; after responsibility split, `rtk bun test --preload=./packages/cli/_test/setup.ts packages/cli/src/plugin-commands/loopback/server.test.ts packages/cli/src/plugin-commands/loopback/fixed-port-fallback.test.ts` → 13 pass, 0 fail, 39 expects |
| Shared secret collector and three consumers | `rtk bun test packages/core/_test/plugins/diagnostic.test.ts packages/core/src/plugins/loader/options-and-secrets.test.ts packages/core/src/plugins/account-login/create.test.ts packages/core/src/plugins/credential-port/redaction.test.ts` → 16 pass, 4 fail, 1 module-export error | same command → 30 pass, 0 fail, 113 expects |
| Future descriptor brand | `rtk bun test packages/core/src/plugins/loader/descriptor.test.ts --test-name-pattern 'future descriptor brand'` → 0 pass, 1 fail | `rtk bun test packages/core/src/plugins/loader/descriptor.test.ts` → 11 pass, 0 fail, 28 expects |
| Dashboard resolver/page split | first focused Rstest run → 2 failed files, 0 tests (`@aio-proxy/plugin-sdk` workspace link not refreshed); after `rtk bun install --frozen-lockfile`, `rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/providers/templates/providers-page.test.tsx src/modules/providers/components/plugins-table.test.tsx` → 2 files, 12 pass, 0 fail | 12 pass, 0 fail |
| Copilot entry point | `rtk bun test packages/plugins/github-copilot/src/plugin.test.ts` | 8 pass, 0 fail, 16 expects |

## Artifact execution boundary

Clean package-unit proof:

1. `rtk mv packages/core/dist /tmp/aio-proxy-core-dist-c797 && rtk mv packages/i18n/dist /tmp/aio-proxy-i18n-dist-c797`
2. `rtk bun run --filter @aio-proxy/core test:unit` → exit 0, 468 pass, 0 fail.
3. `rtk bun run --filter @aio-proxy/i18n test:unit` → 13 pass, 0 fail, 25 expects.
4. Restored both ignored `dist` directories.

Build-smoke proof:

- `rtk bun run --filter @aio-proxy/i18n build` → exit 0.
- Initial Core build found test-only TS4111/implicit-any issues; fixed them. `rtk bun run --filter @aio-proxy/core build` then exited 0.
- Initial artifact command exposed Bun's requirement for `./` when explicitly running non-`*.test.ts` files; fixed both scripts.
- Final `rtk bun run test:artifact` after root build → Core 1 pass/0 fail/4 expects; i18n 3 pass/0 fail/11 expects.

Script wiring:

- Core: `test:artifact = bun test ./_test/build-entry.smoke.ts`
- i18n: `test:artifact = cd ../.. && bun test ./packages/i18n/_test/compile-output.smoke.ts`
- Root: `test:artifact` runs both package smoke commands.
- Root `preflight`: check → unit → Plugin SDK types → root build → artifact smoke.

## Final verification

- `rtk bun run check` → exit 0; 645 files checked, 3 non-failing warnings and 61 informational diagnostics already present in the branch.
- `rtk bun run test:unit -- --concurrency=2` → exit 0. Aggregated package logs: 1,288 pass, 1 skip, 0 fail across 208 files (CLI 148; Core 468; i18n 13; Dashboard 113; GitHub Copilot 26; OpenAI ChatGPT 26; Plugin SDK 16; Server 379; Types 99). The later CLI test-file split was reverified by the 13-test focused command above.
- `rtk bun run build` → 7/7 build tasks successful.
- `rtk bunx tsc -p packages/server/tsconfig.json --noEmit` → exit 0.
- Exact touched TypeScript gate: 26 existing touched `.ts`/`.tsx` files, 0 over 300 lines. Largest: `account-login/login.ts` at 299 lines.
- `rtk git diff --check` → exit 0.
- `rtk rg -n 'github-api/catalog' packages/plugins/github-copilot/src -g '*.ts'` → exit 1, no private imports.
- `rtk rg -n 'resolvePluginCopy' packages/dashboard/src -g '*.ts' -g '*.tsx'` → exit 1, no Dashboard resolver copy.

## Self-review

- Re-read every required finding against the final diff; all seven are represented by code and focused verification.
- Verified manual-only fallback cannot activate for dynamic ports, non-interactive input, or requests that disallow manual callback URLs.
- Verified listener cleanup remains in the existing outer `finally`; manual-only acceptance has no listener to stop and still aborts the losing path.
- Verified the secret collector is not exported through `@aio-proxy/core`, does not invoke redaction failure paths, and all former duplicate collectors were deleted.
- Verified non-integer/malformed descriptor versions still follow the ordinary load-failure path; only unsupported integers receive incompatibility classification.
- Verified Dashboard files keep one React component per `.tsx` file and remain under the 300-line limit.
- Verified artifact smoke runs only after build and ordinary package unit discovery excludes the smoke files.

## Concerns

No blocking concerns. `bun run check` still reports three pre-existing non-failing warnings (including the existing request-log non-null assertion); this fix wave did not expand into unrelated cleanup.
