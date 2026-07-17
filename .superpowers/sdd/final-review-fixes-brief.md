# Final Whole-Branch Review Fixes

Base: `f5aa7084d8726644d0cf963f894511b8952efe4f`

Implement every finding below in one fix wave. Follow TDD for behavior changes,
keep production and test files at most 300 lines, preserve public APIs unless a
finding explicitly requires a new public seam, and do not push or write GitHub
state.

## Required fixes

1. Fixed-port OAuth manual-only fallback
   - `packages/cli/src/plugin-commands/loopback/index.ts` currently terminates
     on every bind failure and never calls `confirmManualOnly`.
   - For an interactive fixed-port request that allows manual callback URL
     entry, a bind failure must ask for explicit confirmation. Acceptance must
     continue with the fixed redirect URI and only the manual callback reader;
     rejection must terminate with the existing user-facing error contract.
   - Add focused acceptance and rejection regressions around the existing
     fixed-port failure coverage. Preserve listener/state/redirect cleanup and
     classification invariants.

2. Clean artifact-test execution boundary
   - `packages/core/_test/build-entry.test.ts` and
     `packages/i18n/_test/compile-output.test.ts` currently require ignored
     `dist/` output, but package-level `test:unit` can run in a clean checkout.
   - Move artifact assertions to explicit artifact/build-smoke commands that
     run after the corresponding package build. Keep ordinary `test:unit`
     source-only and clean-checkout safe. Wire the artifact checks into the
     normal root verification/preflight path after build without nesting a
     mutating build inside a read-only test process.
   - Prove clean package `test:unit` behavior and built artifact smoke behavior.

3. One secret-string collector
   - Consolidate the security-sensitive traversal duplicated in
     `packages/core/src/plugins/account-login/validation.ts`,
     `packages/core/src/plugins/loader/candidates.ts`, and
     `packages/core/src/plugins/credential-port.ts`.
   - Put one tested internal collector beside `redactPluginError` and reuse it
     for loader, login, and refresh paths. Define consistent behavior for
     cycles, duplicate references, empty strings, arrays, and throwing getters
     or proxy properties. Collection must never turn redaction itself into a
     new failure path.
   - Add focused tests demonstrating all three consumers redact/compare using
     the same semantics.

## Smaller fixes to include

4. In `packages/core/src/plugins/loader/descriptor.ts`, descriptor-like objects
   carrying an integer unsupported `apiVersion` must emit
   `PLUGIN_API_INCOMPATIBLE` even when their brand is a future `/v2` value. Add
   a differently branded future-major test.

5. Remove the Dashboard copy of localized-text resolution. Reuse the public
   plugin localization resolver through an appropriate package boundary so the
   locale fallback behavior has one implementation. Avoid importing private
   SDK modules.

6. Re-export `COPILOT_CATALOG_TTL_MS` from
   `packages/plugins/github-copilot/src/github-api/index.ts`; imports outside
   that directory must use the entry point, not private `catalog.ts`.

7. Split `packages/dashboard/src/modules/providers/templates/providers-page.tsx`
   so page/query assembly and provider table column/formatting definition have
   separate owners. Keep component filenames aligned with exports and preserve
   Dashboard Rstest/i18n/TanStack ownership rules.

## Verification and report

- Run focused RED/GREEN tests for each behavior fix.
- Run affected package tests for CLI, Core, i18n, Dashboard, and Copilot as
  appropriate; artifact smoke commands must be run after clean builds.
- Run `bun run check`, root build, Server no-emit if touched transitively, the
  exact touched-file `>300` gate, and `git diff --check`.
- Do not run a broad suite repeatedly; one final full unit run is sufficient
  after focused verification.
- Write exact commands, counts, failures/fixes, and concerns to
  `.superpowers/sdd/final-review-fixes-report.md`.
- Commit all fixes with `Co-authored-by: Codex <noreply@openai.com>`.

## Final review follow-up: artifact boundary

- Direct package `test:unit` scripts must remain read-only: they must not build,
  generate, or mutate package output.
- Core and i18n direct package unit commands must work in a clean checkout with
  their ignored generated output absent. Runtime formatting assertions that
  import generated Paraglide modules belong in the i18n artifact smoke suite;
  source-only assertions remain in ordinary unit discovery.
- Root Turbo unit execution may still materialize configured workspace build
  prerequisites before running package unit tasks; this is distinct from the
  direct package script contract.
- `test:artifact` must declare its build dependency in the Turbo graph. Root
  preflight must invoke that graph-backed artifact task without also running a
  duplicate explicit whole-repository build.
- Preserve the existing `test:unit` Turbo dependencies and the combined unit +
  artifact assertion count while moving tests across the boundary.
