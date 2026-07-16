# OAuth Plugin Review Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the OAuth plugin system against the accepted post-implementation review findings, embed built-in plugins without publishing them, and add host-neutral localized plugin copy.

**Architecture:** Keep built-in plugins as private workspace modules statically linked through core, while publishing only a packed and verified plugin SDK. Localized copy remains inert JSON in plugin descriptors and is resolved by the host at presentation seams. Concurrency and lifecycle fixes deepen the existing repository, credential-port, snapshot, and CLI modules without adding vendor branches.

**Tech Stack:** Bun 1.3.14, TypeScript, Zod 4, SQLite, Hono, React/TanStack Query, Changesets, GitHub Actions.

## Global Constraints

- Built-in plugin identities remain `@aio-proxy/plugin-github-copilot` and `@aio-proxy/plugin-openai-chatgpt`; npm packages with those names never override embedded implementations.
- The two built-in plugin workspace packages are private and are not published to npm.
- `@aio-proxy/plugin-sdk` is the only public plugin package and exports the native Zod instance as `export { z as zod } from "zod"`.
- Plugin runtime execution support is Bun `>=1.3.14`; Node/undici runtime support is out of scope.
- `LocalizedText` is plain JSON: `string | ({ default: string } & Record<string, string>)`; no Proxy is introduced around Zod or descriptors.
- Unknown plugin exceptions remain hidden from CLI users; only explicitly safe user errors retain localized messages.
- Ambiguous rotating refresh-token failures are terminal and require re-login; they are not automatically retried.
- Every production-code change follows RED/GREEN TDD and includes the exact focused test command in its task report.
- Shell commands use `PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk ...`.
- Commits append `Co-authored-by: Codex <noreply@openai.com>`.

---

### Task 1: Correct the Built-in and SDK Release Boundary

**Files:**
- Modify: `packages/plugins/github-copilot/package.json`
- Modify: `packages/plugins/openai-chatgpt/package.json`
- Modify: `.changeset/oauth-plugin-system.md`
- Modify: `.github/workflows/release.yml`
- Create: `scripts/publish-public-packages.ts`
- Create: `packages/plugin-sdk/README.md`
- Create: `packages/cli/_test/binary-build.test.ts`
- Create: `scripts/_test/publish-public-packages.test.ts`

**Interfaces:**
- Consumes: static imports in `packages/core/src/plugins/builtins.ts` and compiled binary construction in `packages/cli/scripts/build-binary.ts`.
- Produces: `packPublicPackage(packageDir, destination)` and a release entrypoint that publishes verified tarballs in SDK/platform/root order.

- [ ] **Step 1: Write failing release-boundary tests**

Add a script test that creates a temporary package containing `catalog:` and `workspace:` dependencies, invokes the manifest verifier, and expects rejection. Add a binary smoke assertion that runs the compiled binary with an empty temporary `AIO_PROXY_HOME` and no workspace cwd, invokes `plugin list`, and finds both canonical built-in package names.

```ts
expect(() => assertPublishableManifest({ dependencies: { zod: "catalog:" } })).toThrow(
  /unsupported dependency protocol/,
);
expect(stdout).toContain("@aio-proxy/plugin-github-copilot");
expect(stdout).toContain("@aio-proxy/plugin-openai-chatgpt");
```

- [ ] **Step 2: Verify RED**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test scripts/_test/publish-public-packages.test.ts packages/cli/_test/binary-build.test.ts
```

Expected: FAIL because the publish helper does not exist and the binary smoke does not inspect embedded plugins.

- [ ] **Step 3: Implement private built-ins and verified tarball publication**

Set both built-in package manifests to `"private": true` and remove `publishConfig`. Remove them from the public changeset release list. Implement a Bun script that runs `bun pm pack --destination`, opens `package/package.json` from the resulting tarball, recursively checks dependency sections for values beginning with `workspace:` or `catalog:`, and publishes that exact tarball. Do not run `npm publish` against a workspace directory.

Replace the release workflow's three-public-package loop and `changeset publish` call with:

```yaml
- name: Publish verified public packages
  run: bun scripts/publish-public-packages.ts
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Keep the existing static imports and build packages as workspace inputs before binary compilation.
Document that plugin runtime hooks execute in the aio-proxy Bun host and that
Node/undici runtime execution is not part of the v1 compatibility promise.

- [ ] **Step 4: Verify GREEN and installability**

Run the focused tests, then pack the SDK and install the tarball into an empty npm project:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test scripts/_test/publish-public-packages.test.ts packages/cli/_test/binary-build.test.ts
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/plugin-sdk build
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun pm pack --cwd packages/plugin-sdk
```

Expected: tests PASS; the packed manifest contains ordinary semver versions and can be installed by npm in an empty directory.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins packages/plugin-sdk .changeset/oauth-plugin-system.md .github/workflows/release.yml scripts packages/cli/_test/binary-build.test.ts
git commit -m "fix(release): embed built-in oauth plugins" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Add Localized Plugin Copy to the SDK and Host

**Files:**
- Create: `packages/plugin-sdk/src/localized-text.ts`
- Modify: `packages/plugin-sdk/src/config.ts`
- Modify: `packages/plugin-sdk/src/oauth.ts`
- Modify: `packages/plugin-sdk/src/plugin.ts`
- Modify: `packages/plugin-sdk/src/index.ts`
- Test: `packages/plugin-sdk/_test/localized-text.test.ts`
- Modify: `packages/core/src/plugins/config-spec.ts`
- Modify: `packages/core/src/plugins/registry.ts`
- Modify: `packages/core/src/plugins/builtins.ts`
- Test: `packages/core/_test/plugins/config-spec.test.ts`
- Test: `packages/core/_test/plugins/builtins.test.ts`
- Modify: `packages/cli/src/plugin-commands/config-form.ts`
- Modify: `packages/cli/src/plugin-commands/authorization.ts`
- Modify: `packages/cli/src/plugin-commands/provider-login.ts`
- Modify: `packages/dashboard/src/modules/providers/components/provider-options-editor.tsx`
- Test: `packages/cli/_test/plugin-form.test.ts`
- Test: `packages/cli/_test/plugin-authorization.test.ts`
- Test: `packages/dashboard/src/modules/providers/components/provider-options-editor.test.ts`
- Modify: `packages/plugins/github-copilot/src/index.ts`
- Modify: `packages/plugins/openai-chatgpt/src/index.ts`

**Interfaces:**
- Produces: `LocalizedText`, `LocaleTextMap`, `LocalizedTextSchema`, `resolveLocalizedText(text, locale)`, and host validators that clone maps to plain data.
- Consumes: host locale from `@aio-proxy/i18n` at CLI and Dashboard presentation time.

- [ ] **Step 1: Write failing SDK tests**

Cover string passthrough, canonical exact match, base-language fallback, required `default`, invalid/non-canonical tags, empty values, and JSON round-trip.

```ts
expect(resolveLocalizedText({ default: "Default", "zh-Hans": "中文" }, "zh-Hans")).toBe("中文");
expect(resolveLocalizedText({ default: "Default", en: "English" }, "en-US")).toBe("English");
expect(resolveLocalizedText({ default: "Default" }, "broken_locale")).toBe("Default");
```

Add host contract tests proving an accessor-backed locale map is read once and normalized into a plain object, and that form/select/device/progress fields accept locale maps.

- [ ] **Step 2: Verify RED**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/plugin-sdk/_test/localized-text.test.ts packages/core/_test/plugins/config-spec.test.ts packages/core/_test/plugins/builtins.test.ts
```

Expected: FAIL because `LocalizedText` and its resolver do not exist and validators only accept strings.

- [ ] **Step 3: Implement the SDK contract and host materialization seam**

Implement the public types and resolver without Proxy. Extend display-copy fields while leaving account metadata labels as `string`. Validate locale maps by copying own enumerable string entries into a null-prototype intermediate, rejecting accessor descriptors, symbols, cycles, missing/empty default, invalid keys, and keys not equal to `Intl.getCanonicalLocales(key)[0]`.

Core built-ins must construct descriptors containing both English and `zh-Hans` copy instead of calling `m[...]()` during descriptor creation. CLI resolves copy immediately before prompt/print calls. Dashboard receives the validated raw locale map and resolves it using `getLocale()` when rendering, so a locale change does not reload a plugin.

- [ ] **Step 4: Verify GREEN across SDK, core, CLI, and Dashboard**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/plugin-sdk/_test packages/core/_test/plugins/config-spec.test.ts packages/core/_test/plugins/builtins.test.ts packages/cli/_test/plugin-authorization.test.ts packages/cli/_test/plugin-form.test.ts packages/dashboard/src/modules/providers/components/provider-options-editor.test.ts
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/plugin-sdk test:types
```

Expected: all focused tests and SDK type fixtures PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-sdk packages/core/src/plugins packages/core/_test/plugins packages/cli packages/dashboard packages/plugins
git commit -m "feat(plugin-sdk): support localized plugin copy" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Restore Plugin and Provider Failure Isolation

**Files:**
- Modify: `packages/core/src/plugins/loader.ts`
- Modify: `packages/core/src/plugins/repository.ts`
- Modify: `packages/server/src/server-state.ts`
- Modify: `packages/server/src/plugin-runtime.ts`
- Test: `packages/core/_test/plugins/loader.test.ts`
- Test: `packages/core/_test/plugins/repository.test.ts`
- Test: `packages/server/_test/plugin-runtime.test.ts`
- Test: `packages/server/_test/plugin-snapshot.test.ts`

**Interfaces:**
- Produces: per-plugin secret-read outcomes and provider-local schema-contract diagnostics.
- Preserves: successful candidate snapshot construction for healthy API, AI SDK, and plugin providers.

- [ ] **Step 1: Write failing isolation tests**

Add tests where one plugin secret reader throws, one stored `plugin_secret.value_json` is corrupt, and one credential schema `safeParse` throws or returns a malformed contract result. Each fixture must also include a healthy provider and assert that only the affected plugin/provider is unavailable.

- [ ] **Step 2: Verify RED**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins/loader.test.ts packages/core/_test/plugins/repository.test.ts packages/server/_test/plugin-runtime.test.ts packages/server/_test/plugin-snapshot.test.ts
```

Expected: FAIL because secret decode and credential schema contract errors reject the whole candidate snapshot.

- [ ] **Step 3: Move reads and parsing inside the correct isolation seams**

Move plugin secret loading and secret-leaf collection inside the candidate `try`. Replace server-wide eager secret `Map` construction with an outcome map that retains the read error for the relevant package. Do not treat corrupt JSON as absent.

Wrap credential `parsePluginSchema()` separately. Map ordinary parse failure to `CREDENTIALS_MISSING_OR_INVALID`; map `PluginSchemaContractError` to a plugin/provider contract diagnostic containing plugin, capability, and providerId without a targeted-login suggestion.

- [ ] **Step 4: Verify GREEN**

Run the same focused command. Expected: all tests PASS and initial startup/reload constructs a snapshot containing healthy providers.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins packages/core/_test/plugins packages/server/src packages/server/_test
git commit -m "fix(plugins): isolate corrupt plugin state" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Fence Credential Refresh and Preserve Error Semantics

**Files:**
- Modify: `packages/core/src/plugins/repository.ts`
- Modify: `packages/core/src/plugins/credential-port.ts`
- Modify: `packages/server/src/plugin-runtime.ts`
- Modify: `packages/plugins/openai-chatgpt/src/runtime.ts`
- Test: `packages/core/_test/plugins/repository.test.ts`
- Test: `packages/core/_test/plugins/credential-port.test.ts`
- Test: `packages/server/_test/plugin-snapshot.test.ts`
- Test: `packages/plugins/openai-chatgpt/_test/runtime.test.ts`

**Interfaces:**
- Changes: refresh CAS consumes `leaseOwner` and atomically fences revision plus owner.
- Produces: best-effort diagnostic write result, complete dynamic secret redaction, terminal refresh diagnostics, and metadata-driven summary convergence.

- [ ] **Step 1: Write failing concurrency, error, redaction, and metadata tests**

Cover stale owner A losing the lease to B and failing CAS; concurrent account deletion preserving the original exchange error; account and plugin secret values being redacted from message and stack; terminal failure exposing `retryable: false`; ChatGPT returning new `expiresAt`; and provider summaries updating after metadata CAS.

- [ ] **Step 2: Verify RED**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins/repository.test.ts packages/core/_test/plugins/credential-port.test.ts packages/server/_test/plugin-snapshot.test.ts packages/plugins/openai-chatgpt/_test/runtime.test.ts
```

Expected: FAIL for stale-owner commit, FK error replacement, unredacted secret, retryable diagnostic, or stale expiry summary.

- [ ] **Step 3: Implement the fenced refresh transaction**

Pass the acquired owner into the refresh-only CAS. In a single immediate transaction, update the account only when provider ID, expected credential revision, and an unexpired lease row with the same owner all match. Return `null` on a lost fence and reread the winning snapshot.

Change diagnostic insertion to `INSERT ... SELECT ... WHERE EXISTS (...)` and return whether a row changed. Catch secondary diagnostic persistence failure without replacing the primary refresh error. Build redaction values from credential, account-secret, and materialized plugin-secret leaves.

Mark unclassified refresh failure `retryable: false` with re-login guidance. When CAS changes account metadata, invoke a credential-state callback that queues summary convergence while preserving runtime identity. ChatGPT returns `metadata: { expiresAt: value.expiresAt }`.

- [ ] **Step 4: Verify GREEN**

Run the focused command twice, including the two-database-handle repository test. Expected: all tests PASS without timing retries.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins packages/core/_test/plugins packages/server packages/plugins/openai-chatgpt
git commit -m "fix(oauth): fence rotating credential refresh" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 5: Make Account Deletion Safe Across Re-add Races

**Files:**
- Modify: `packages/core/src/plugins/repository.ts`
- Modify: `packages/server/src/account-removal.ts`
- Modify: `packages/server/src/server-state.ts`
- Modify: `packages/server/src/dashboard-routes/config.ts`
- Test: `packages/core/_test/plugins/repository.test.ts`
- Test: `packages/server/_test/account-removal.test.ts`
- Test: `packages/server/_test/plugin-snapshot.test.ts`
- Test: `packages/server/_test/dashboard-providers-mutation.test.ts`

**Interfaces:**
- Produces: named pending-operation conflicts, stale-delete cancellation/supersession, and final deletion fenced by config plus snapshot manager.

- [ ] **Step 1: Write the failing delete/re-add/delete tests**

Hold a lease on the first snapshot. Delete provider P, re-add P, delete P again, then release leases in adversarial order. Assert the Dashboard never returns 500, the current Router never refers to a deleted account, the old operation finalizes as superseded, and only the marker associated with the final routed incarnation may delete the account.

- [ ] **Step 2: Verify RED**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins/repository.test.ts packages/server/_test/account-removal.test.ts packages/server/_test/plugin-snapshot.test.ts packages/server/_test/dashboard-providers-mutation.test.ts
```

Expected: FAIL with a raw pending-operation error/HTTP 500 or an account deleted while P remains current.

- [ ] **Step 3: Implement operation supersession and final deletion fencing**

Use a named repository result/error for incompatible pending operations. On successful re-add commit, atomically cancel the old delete marker. When deleting again, supersede the old delete operation and create a new operation ID. Route physical finalization through the server FIFO; while holding the shared config lock, re-read provider absence and call `snapshotManager.canDeleteAccount(providerId)` immediately before conditional repository finalization. Retain and reschedule the marker when either condition is false.

- [ ] **Step 4: Verify GREEN**

Run the focused tests. Expected: all adversarial sequences PASS and Dashboard conflicts are 409 rather than 500.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins packages/core/_test/plugins packages/server
git commit -m "fix(server): fence oauth account deletion" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 6: Fail Closed in CLI and Loopback Authorization

**Files:**
- Modify: `packages/cli/src/plugin-commands/plugin.ts`
- Modify: `packages/cli/src/plugin-commands/provider-login.ts`
- Modify: `packages/cli/src/plugin-commands/loopback.ts`
- Modify: `packages/cli/src/plugin-commands/authorization.ts`
- Modify: `packages/cli/src/provider-commands.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/open-browser.ts`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Test: `packages/cli/_test/plugin-commands.test.ts`
- Test: `packages/cli/_test/provider-plugin-login.test.ts`
- Test: `packages/cli/_test/plugin-authorization.test.ts`
- Test: `packages/cli/_test/cli.test.ts`
- Create: `packages/cli/_test/open-browser.test.ts`

**Interfaces:**
- Produces: fail-closed confirmation adapter, safe provider-login user-error family, fixed-port bind terminal error, precise provider-target errors, and quoted Windows browser invocation.

- [ ] **Step 1: Write failing prompt and top-level CLI tests**

Capture the real `@inquirer/confirm` options and assert `default: false`. Add top-level CLI tests for missing capability, account conflict, loopback port failure, and an unknown plugin error; safe errors must retain localized text while the unknown error remains generic. Add a fixed-port occupied test asserting the browser is never opened. Add a Windows command fixture containing `&state=` and assert it remains one argument.

- [ ] **Step 2: Verify RED**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/cli/_test/plugin-commands.test.ts packages/cli/_test/provider-plugin-login.test.ts packages/cli/_test/plugin-authorization.test.ts packages/cli/_test/cli.test.ts packages/cli/_test/open-browser.test.ts
```

Expected: FAIL because confirmation defaults to Yes, safe login errors are collapsed, fixed-port fallback opens the compromised redirect URI, and Windows command quoting is incomplete.

- [ ] **Step 3: Implement fail-closed presentation and safe error transport**

Pass `default: false` to all trust/destructive/manual confirmations. Export a closed set or wrapper type for already-localized provider-login and loopback user errors and include only that family in top-level safe rendering. Preserve generic redaction for all other errors.

Abort fixed-port authorization immediately on bind failure. Distinguish provider-not-found, provider-not-OAuth/invalid, and actual cleanup-pending errors. Quote/escape the Windows URL as one `cmd /c start` argument without invoking a shell string assembled from user-controlled URL contents.
Add localized help text for `--provider` and assert it appears in CLI help.

- [ ] **Step 4: Verify GREEN and compile i18n**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run i18n:compile
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/cli/_test/plugin-commands.test.ts packages/cli/_test/provider-plugin-login.test.ts packages/cli/_test/plugin-authorization.test.ts packages/cli/_test/cli.test.ts packages/cli/_test/open-browser.test.ts
```

Expected: all focused tests PASS and generated i18n outputs are clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli packages/i18n
git commit -m "fix(cli): fail closed during plugin authorization" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 7: Enforce Migration, Lock, and Built-in Runtime Reliability

**Files:**
- Create: `.gitattributes`
- Modify: `packages/core/scripts/build-migrations.ts`
- Modify: `packages/core/src/db/migrations/0004_oauth_plugins.sql`
- Modify: `packages/core/src/db/schema/plugin-oauth.ts`
- Modify: `packages/core/src/db/migrations.manifest.ts`
- Modify: `packages/core/src/plugins/config-file.ts`
- Modify: `packages/core/src/npm-lock.ts`
- Modify: `packages/server/src/server-state.ts`
- Modify: `packages/plugins/github-copilot/src/index.ts`
- Modify: `packages/plugins/github-copilot/src/github-api.ts`
- Modify: `packages/plugin-sdk/src/config.ts`
- Modify: `packages/dashboard/src/modules/providers/templates/providers-page.tsx`
- Test: `packages/dashboard/src/modules/providers/components/provider-state-cell.test.tsx`
- Create: `packages/dashboard/src/modules/providers/templates/providers-page.test.tsx`
- Test: corresponding core, server, and Copilot focused tests
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: non-mutating migration check mode, observable config-lock release failure, aligned recovery fencing, closed-state rebuild guard, stricter Copilot URL validation, and restored model Accept header.

- [ ] **Step 1: Write failing reliability tests**

Add a temporary migration tree test where `--check` detects a stale manifest without modifying it. Add config-lock release failure injection asserting the transaction rejects and a subsequent owner recovery path can progress. Add parity coverage for changed recovery-marker content. Add a server close test where a late diagnostic does not enqueue rebuild. Add Copilot credential schema and request-header assertions.

- [ ] **Step 2: Verify RED**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test packages/server/_test/plugin-snapshot.test.ts packages/plugins/github-copilot/_test
```

Expected: focused new tests FAIL because check mode writes/returns zero, release errors are swallowed, late diagnostics enqueue work, invalid URLs pass schema, or Accept is missing.

- [ ] **Step 3: Implement the reliability changes**

Parse `--check` explicitly. In check mode compare generated content to the committed file, print a stable mismatch message, do not write, and set a non-zero exit code. Add CI execution after repository checks. Set migration SQL to `text eol=lf`, remove the redundant ordinary index from SQL and schema, regenerate the manifest, and verify the existing append-only policy accepts the pre-release edit.

Propagate lock release failure through the transaction result and retain enough owner identity to retry/recover the lock safely. Treat changed recovery-marker content conservatively in both lock implementations. Guard diagnostic rebuild enqueue and execution with server closed state.

Change Copilot `baseURL` to `zod.url()` and add `accept: "application/json"` to model discovery headers.
Remove the overloaded secret-placeholder masking behavior so secret hints and
masking are not inferred from the same field. Render provider expiry/catalog
timestamps with the current browser locale and cover deterministic locale
formatting in Dashboard tests.

- [ ] **Step 4: Verify GREEN and repository-wide gates**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/core build:migrations --check
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run check
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run test:unit -- --concurrency=2
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run test:e2e:api
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run build
```

Expected: migration check makes no diff; check, unit, API e2e, and build all PASS.

- [ ] **Step 5: Commit**

```bash
git add .gitattributes .github/workflows/ci.yml packages/core packages/server packages/plugins/github-copilot
git commit -m "fix: harden plugin migration and runtime gates" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 8: Final Verification and Review Closure

**Files:**
- Modify: `.superpowers/sdd/progress.md`
- Verify: entire branch against merge base

**Interfaces:**
- Consumes: Tasks 1-7.
- Produces: a reviewed, pushed PR head with green CI and an explicit accepted/deferred review ledger.

- [ ] **Step 1: Run release-grade verification**

Run check, unit with CI concurrency, API e2e, build, SDK pack/install, compiled binary built-in smoke, migration check, clean-break scan, and `git diff --check`.

- [ ] **Step 2: Dispatch final whole-branch review**

Generate a review package from `git merge-base main HEAD` to `HEAD`. The reviewer must compare the diff with both OAuth design specs, inspect all accepted Claude findings, and report Critical/Important/Minor findings without pre-judged exclusions.

- [ ] **Step 3: Fix Critical and Important findings with RED/GREEN tests**

Dispatch one fix agent with the complete finding list, require focused failing tests before production changes, rerun affected suites, and re-review the new range.

- [ ] **Step 4: Update the durable ledger and push**

Record every task commit range and review verdict in `.superpowers/sdd/progress.md`, commit the ledger if tracked by the branch workflow, push `codex/oauth-plugin-system-design`, and wait for GitHub CI. Do not reply to or resolve GitHub review threads unless the user explicitly requests that write action.
# Migration note

The project remained unreleased after this plan was executed. The final implementation therefore replaces the custom append-only manifest check below with one Drizzle-generated baseline, committed metadata, and a clean-tree CI check.
