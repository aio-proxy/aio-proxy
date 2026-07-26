# Lint Refactor — Findings

Record of the full-repo lint cleanup after the tightened `oxlint`/`oxfmt` rules in commit
`34c7db6`. The work was a **behavior-preserving structural refactor**: long functions/files
split to satisfy `max-lines-per-function` (120) and `max-lines` (300), plus 2 real
`consistent-type-imports` errors fixed. Per the agreed constraint, **no bug or smell surfaced
during the refactor was fixed** — they are recorded below for follow-up. The only code changes
beyond splitting were regressions the split itself introduced (listed first) and the source
fixes needed to make the build/test gate pass.

## What was done

- **Errors (2)** — `consistent-type-imports`: `provider-runtime/probe.ts` (split the
  `ProviderKind`/`ProviderProtocol` import into type-only + value), `server-state/types.ts`
  (`typeof import(...)` → named `import type` + `typeof recoverPendingAccountOperations`).
- **Warnings (129)** — 34 source + 95 test, split across ~100 files into sibling scenario test
  files and directory-module source splits. Now **0 lint warnings, 0 errors**.
- **`_test/` → `__tests__/`** — all 8 legacy test dirs renamed repo-wide (incl. `scripts/`),
  with every relative import, `package.json` `test:unit` glob, and tsconfig include updated.
- **`bun run format`** — full-repo format applied (the `34c7db6` `oxfmt` `singleQuote` change
  had left ~1010 files unformatted).

## Regressions introduced by the split and fixed during verification

These broke the build/test gate and were corrected (not deferred), since the deliverable is a
green refactor:

- `routes/pipeline/attempt.ts` — the split **dropped the `withAttemptLogContext` import** from
  `../../request-logging`, leaving a runtime `ReferenceError` that failed **141 server tests**.
  Import restored.
- `plugins/account-login/login/stage.ts` — extracted one directory deeper but kept `../`
  imports valid only at the old depth; `../config-file`, `../diagnostic/index`,
  `../provider-id`, `../repository/index` corrected to `../../`. (Broke core build.)
- `core/src/transform/openai-completions/openai-completions.test.ts` — split left the
  `expectedRoundTrip` helper missing its closing `}` (EOF parse error). Brace restored.
- New `src/**/*.test-support.ts` files were pulled into library declaration generation and
  failed `.d.ts` emit. Fixed at the source: excluded `*.test-support.*` from the build entry
  in `packages/infra/src/rslib.ts` and from tsconfig `exclude` in every building package
  (types, plugin-sdk, core, and the 4 buildable plugins), mirroring the existing `*.test.*`
  exclusion. Removed one orphaned `types/__tests__/schemas.test-support.d.ts(.map)` artifact.

## Pre-existing issues to follow up (recorded, NOT fixed)

### Potential correctness

- `dashboard/src/modules/logs/components/logs-filters.tsx` — `const now = new Date()` recomputed
  every render flows into `DateTimeRangePicker max={endOfDay(now)}`; the max bound drifts per
  render.
- `dashboard/.../provider-variant-fields.tsx` — Select `onValueChange` guards `if (model ===
null) return`, but radix Select emits a string, never null — likely dead guard.
- `dashboard/.../providers-table-columns.tsx` — status `accessorFn` interpolates
  `provider.state.catalog ?? ''` into the filter string; a non-string `catalog` renders
  `"[object Object]"`. Verify `catalog` is a string.
- `core/src/plugins/repository/pending-operations.ts` — `compensateAccountOperation` compares
  `encodeJson(childSnapshot(...)) === encodeJson(rollback.applied)`, relying on stable JSON key
  ordering; fragile to future field reordering.
- `server/src/routes/pipeline/attempt.ts` (raw fallback) — a body-cancelled response can be
  assigned to `lastFailure` and returned if it were the last candidate; guarded today by
  `fallback` requiring `hasNext`, but subtle.
- `server/src/server-state/index.ts` — `runtime.accountRemovals`/`scheduler`/`manager`
  initialized as `undefined as unknown as T` then assigned; any read before assignment is an
  undefined deref. The `managerReady` / `startupDiagnosticRebuildPending` ordering is subtle and
  under-tested.

### Test hazards

- `dashboard/.../logs-page.filters.test.tsx` — `test.each` mutates module-level `mocks.mode` and
  resets inside the callback, not `afterEach`; a thrown assertion leaves it dirty for later tests.
- `server/__tests__/dashboard-providers-mutation.test-support.ts` — fixture binds a single fixed
  port (22079) for all servers; if the runner ever parallelizes these files, a latent collision.
  Splitting increased the file count sharing this fixture.
- Widespread real-clock timers in tests (`Bun.sleep`, `setTimeout` deadlines) across
  `plugin-sdk/openai-stream`, `cli/plugin-commands/plugin`, `core/npm-lock`,
  `core/plugins/config-file`, `server` mutation tests — flake-prone under CI load
  (`ts-no-test-timers`). Pre-existing integration style; left verbatim.

### Style-rule debt in moved-verbatim code

- `ts-no-return-type` (`ReturnType<typeof fn>`) is pervasive and effectively the established
  convention for un-nameable third-party/form types: `oauth-login-session/manager.ts`,
  dashboard form components (`form: ReturnType<typeof useXForm>`), `cli/.../loopback/run.ts`
  (`Bun.serve`), `db/request-log/chart.ts` (drizzle `and`), several tests. Not fixed — fixing
  would introduce a second convention beside the existing one.
- `ts-set-map` on small static tables (`db/request-log/chart.ts` reservedSeriesKeys,
  `plugin-quota/test-support.ts`), `ts-no-inline-cast-access` in egress SSE assertions,
  `as never` negative-case casts in `plugins/registry.test.ts` — all pre-existing, verbatim.

## `lint:types` (type-aware) — test exemption + source cleanup

`bun run lint:types` (`oxlint --type-aware --type-check`) had **1392 pre-existing errors**,
all predating the lint-rule change. Not part of base `lint` (which is 0/0), but `preflight`
runs it. Breakdown: **1226 (88%) in test files**, 166 in source. Of the 1392, 964 were raw TS
compiler diagnostics (from `--type-check`) and 428 were oxlint type-aware rules.

Resolution (agreed):

- **Test files exempted from `lint:types`** via `--ignore-pattern` on that script only
  (`*.test.ts`, `*.test.tsx`, `__tests__/**`, `*test-support.ts`, `test-support/**`, `*.smoke.ts`).
  Base `lint` is unaffected — tests still get the full non-type-aware lint. Rationale: test-file
  type errors (`TS7006` implicit-any, `TS2769` overload mismatch) are deliberate looseness for
  mocks/malformed inputs; type-aware there is high-noise, low-value. This drops 1392 → 163.
- **Mechanical source fixes applied:** `z.string().datetime()` → `z.iso.datetime()` (7,
  behavior-verified equivalent); all 42 `TS4111` index-signature accesses (`obj.prop` →
  `obj['prop']`) across `passthrough-usage.ts`, `scripts/publish-public-packages.ts`, and 6
  cli/dashboard files.
- **`no-deprecated` migrations applied (25):** each verified against the installed package's
  `.d.ts`, behavior-preserving:
  - AI-SDK `CallSettings` → named `AiSdkCallSettings = LanguageModelCallOptions &
Partial<Pick<RequestOptions,'maxRetries'|'abortSignal'|'headers'>>` (defined in
    `core/ai-sdk-bridge` and `plugin-sdk/runtime`, both re-exporting; 8 sites). Field shapes
    identical, annotation-only change.
  - AI-SDK `streamText({ includeRawChunks: true })` → `{ include: { rawChunks: true } }`.
  - zod `.passthrough()` → `.loose()` (6, keeps unknown keys — verified), `z.string().email()`
    → `z.email()` (1), `ZodIssue` re-export → `type ZodIssue = z.core.$ZodIssue` (no new dep;
    `zod` already ships `z.core`).
  - TanStack `useStore` → `useSelector` from `@tanstack/react-store` (added as a direct
    dashboard dep, `^0.11.0`; 2-arg call is a drop-in). DOM `event.which === 229` IME guard →
    `event.nativeEvent.isComposing` (the standard replacement; the colocated test now simulates
    IME via `isComposing: true`).
  - bun:sqlite `db.exec()` → `db.run()` (6; `exec` is a documented alias of `run`, and `run`
    handles multi-statement migration SQL — verified).

**Remaining: 92 source-only `lint:types` errors** — deliberately NOT fixed (need real
decisions, not mechanical edits). Follow-up candidates:

- `no-deprecated` (6, all in `image-input.ts` / gemini + openai-completions `*-from-model.ts`):
  `.type` comparisons on AI-SDK's content-part union that still _includes_ the deprecated
  `ImagePart` variant — the deprecation is inherited from the upstream union, not our code;
  fixing needs excluding `ImagePart` from the `ModelMessage`-derived types, not a token swap.
- Structural type debt: dashboard `DashboardLocalizedText` ↔ plugin-sdk `LocalizedText`
  mismatch (`LocaleTextMap` requires `default`), `TS2345`/`TS2322`/`TS2375`
  (`exactOptionalPropertyTypes`), `TS2589` deep instantiation on the oauth form-field union.
  These are genuine type-soundness issues spanning shared types; scope them as a separate task.
- **`@aio-proxy/i18n` `tree-shake-spike.test.ts`** times out at its hardcoded 30s limit: the
  `bunx @inlang/paraglide-js compile` step alone takes ~31.5s in this environment (measured,
  exits 0). The test body is byte-identical to `HEAD` (only the `_test/`→`__tests__/` rename +
  oxfmt quotes). Environment/tooling speed, not a refactor regression.

## Verification

- `bun run lint` → exit 0, **0 errors, 0 warnings**.
- `bun run format:check` → exit 0.
- `bun run build` → all 10 packages build.
- `bun run test` → every package **0 fail** (server 618, core 803, cli 160, dashboard 176,
  google-antigravity 424, types 80, plugin-sdk 68, and the rest), except the pre-existing i18n
  spike timeout above.
