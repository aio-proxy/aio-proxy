# Local Sign-In Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a subscription Provider reuse the sign-in a vendor tool already keeps on this machine (Codex, GitHub Copilot) instead of a browser OAuth round trip.

**Architecture:** An optional `localSignIn` capability on `OAuthAdapter` (detect / read / optional write). `loginOAuthAccount` gains a `localSignIn` switch that replaces the authorization step with `read` and marks the stored account. A core wrapper around `CredentialPort` runs inside the framework's exchange callback (inside the refresh lease, before CAS) and keeps marked accounts whose adapter implements `write` in sync with the host store: newer-of-host-and-mirror wins, rotated credentials are written back only if the host still holds the credential the exchange started from. The same wrapper covers catalog discovery during linking and the server runtime.

**Tech Stack:** Bun, TypeScript, zod, drizzle (SQLite migrations), Hono, React + TanStack Query, es-toolkit.

**Spec:** `docs/superpowers/specs/2026-10-02-local-sign-in-design.md`

## Global Constraints

- Host stores are read only after an explicit user action per account; `detect` checks presence only and never parses or returns secrets.
- No server code branches on a bundled plugin's identity; everything goes through `adapter.localSignIn`.
- Removing a Provider never calls `write` and leaves host store bytes unchanged.
- No credential value read from a host store appears in logs, traces, diagnostics, error messages/stacks/causes, or API responses. Account IDs are treated like browser login (may appear in the suggested Provider ID).
- Tests use temporary directories (`CODEX_HOME`, `XDG_CONFIG_HOME`); never touch the real `~/.codex` or `~/.config/github-copilot`.
- `isPlainObject` (es-toolkit/predicate) for parsed host-store JSON; `isRecord` (`@aio-proxy/shared`) for the adapter contract in the registry.
- SDK change is additive only (rebases over #476's quota-scope change in the same file).
- Non-test implementation files ≤ 500 lines; new tests colocated in same-name directories; existing legacy test files may receive new cases when the module itself is not materially changed.
- Changesets: one targeting `@aio-proxy/plugin-sdk` (minor); one targeting `aio-proxy` plus every internal package touched (minor). One short paragraph each.

## Review Focus

1. `auth.json` with `auth_mode: "apikey"` but leftover complete `tokens` — read must reject it. Test in Task 5.
2. `auth.json` is a symlink (dotfile managers) — write-back replaces the target's contents and keeps the link. Test in Task 5.
3. The user signs Codex into another account while aio-proxy's exchange is in flight — write-back must skip, not clobber the new account. Test in Task 2 (wrapper) and Task 5 (plugin `previous` check).
4. Host access token already expired at link time — discovery refreshes it and the host ends up holding the rotated token. Test in Task 3.
5. Copilot with Enterprise options while the host store only has `github.com` — read fails cleanly naming no token. Test in Task 6.

---

### Task 1: SDK capability and registry validation

**Files:**
- Modify: `packages/plugin-sdk/src/oauth.ts` (types after `OAuthCredentialImporter`; field on `OAuthAdapter`)
- Modify: `packages/core/src/plugins/registry.ts` (`validateLocalSignIn` beside `validateCredentialImports`)
- Test: colocated registry test (create `packages/core/src/plugins/registry/` layout only if this task materially changes more than the validator; otherwise add cases to the existing registry test file)
- Create: `.changeset/plugin-sdk-local-sign-in.md`; Modify: `packages/plugin-sdk/README.md` and the website plugin-SDK page

**Interfaces — Produces:**
```ts
export type OAuthLocalSignInContext = { readonly signal: AbortSignal };
export type OAuthLocalSignIn<AccountOptions, Credential> = {
  readonly source: LocalizedText;
  readonly detect: (context: OAuthLocalSignInContext) => Promise<boolean>;
  readonly read: (context: OAuthCredentialImportContext, options: AccountOptions) => Promise<OAuthLoginResult<Credential>>;
  readonly write?: (context: OAuthLocalSignInContext, next: Credential, previous: Credential) => Promise<void>;
};
// OAuthAdapter: readonly localSignIn?: OAuthLocalSignIn<AccountOptions, Credential>;
```
JSDoc: `detect` presence only; `read` must return `expiresAt`; `write` only for rotating stores, must replace only when the host still holds `previous`, otherwise return without writing.

- [ ] **Step 1: Failing tests** — `registers an adapter with localSignIn and keeps its methods bound`; `rejects localSignIn missing detect/read or with a non-function write` (expects `Error('Invalid OAuth adapter')`).
- [ ] **Step 2: Run** `bun test packages/core/src/plugins` (registry tests) — FAIL.
- [ ] **Step 3: Implement** types and `validateLocalSignIn(value: unknown): OAuthAdapter['localSignIn'] | undefined` (`isRecord`, bind methods).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Docs + changeset** — SDK section "Using a sign-in already on this machine"; changeset: plugins can offer a vendor tool's existing local sign-in as an alternative to the browser flow.
- [ ] **Step 6: Commit** `feat(plugin-sdk): optional local sign-in capability on OAuthAdapter`.

### Task 2: Core sync wrapper

**Files:**
- Create: `packages/core/src/plugins/local-sign-in/index.ts`, `local-sign-in.ts`, `local-sign-in.test.ts`; export from `packages/core/src/index.ts`

**Interfaces — Produces:**
```ts
export type LocalSignInLink = {
  readonly localSignIn: OAuthLocalSignIn<unknown, unknown>; // write is defined
  readonly options: unknown;
  readonly fingerprint: string;
  /** Current marker and mirror expiry, read inside the lease; null/linked:false → plain exchange. */
  readonly account: () => { readonly linked: boolean; readonly expiresAt?: number } | null;
  readonly onWriteFailed: () => void;
};
export function linkLocalSignInCredentials(port: CredentialPort<unknown>, link: LocalSignInLink): CredentialPort<unknown>;
export class LocalSignInAccountChangedError extends CredentialRefreshError; // retryable false, reason 'local_sign_in_account_changed'
export class LocalSignInUnavailableError extends CredentialRefreshError;    // retryable true, reason 'local_sign_in_unavailable', no cause
```
`refresh(rev, exchange)` → `port.refresh(rev, async (current, signal) => …)`:
1. `account()` not linked → `return exchange(current, signal)`.
2. `host = read(...)`; any throw → `LocalSignInUnavailableError`. `host.fingerprint !== fingerprint` → `LocalSignInAccountChangedError`.
3. `base = (host.expiresAt ?? 0) > (account().expiresAt ?? 0) ? host.credentials : current.value`.
4. `result = exchange({ ...current, value: base }, signal)`; a throw is rethrown through `redactPluginError(error, { secretValues: collectSecretStrings([host.credentials, base]) })`.
5. If `!signal.aborted`: `write({ signal }, result.value, base)`; a throw is caught and reported through `link.onWriteFailed()` (no error object passed), never rethrown, since the mirror must still be updated. Return `result`.

- [ ] **Step 1: Failing tests** (fake `localSignIn` over an in-memory "host", fake exchange that rotates `refreshToken` and records its input):
  - `uses the host credential when the host refreshed after the mirror`
  - `uses the mirror and repairs the host when the last write-back failed` (host expiry older than mirror)
  - `writes the rotated credential back with the base as previous`
  - `a failing write still returns the rotated credential so the mirror is updated`
  - `skips write when the signal aborted during exchange` (late callback)
  - `fails non-retryably and does not write when the host holds a different account`
  - `exchanges plainly without reading the host once the marker is cleared` (stale runtime after browser re-login)
  - `errors from read, exchange, and write carry no host credential string in message, stack, or cause`
- [ ] **Step 2: Run** `bun test packages/core/src/plugins/local-sign-in` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(core): keep linked accounts in sync with the host sign-in`.

### Task 3: Account marker and local-sign-in login path

**Files:**
- Modify: `packages/core/src/db/schema/plugin-oauth.ts` — `localSignIn: integer('local_sign_in', { mode: 'boolean' }).notNull().default(false)`
- Create: migration with `bunx drizzle-kit generate` in `packages/core`, then `bun run build:migrations`
- Modify: `packages/core/src/plugins/repository/{types.ts,rows.ts,accounts.ts,pending-operations.ts}` — `StoredAccount.localSignIn?: true`, `AccountWrite.localSignIn?: true`, insert/update persist it (update writes it unconditionally so a browser re-login clears it)
- Modify: `packages/core/src/plugins/account-login/login.ts`; create `account-login/login/local-sign-in.ts` for the read branch; `login/stage.ts` (`buildAccountWrite` copies `ctx.localSignIn`)
- Modify: `account-login/errors.ts` + `account-login/index.ts` exports — `OAuthLocalSignInUnavailableError` (message `OAUTH_LOCAL_SIGN_IN_UNAVAILABLE`), `OAuthLocalSignInInvalidError` (message `OAUTH_LOCAL_SIGN_IN_INVALID`, no cause)
- Test: `packages/core/src/plugins/account-login/local-sign-in.test.ts`

**Interfaces:**
- Consumes: `linkLocalSignInCredentials` (Task 2).
- Produces: `LoginOAuthAccountOptions.localSignIn?: boolean`. When true: account options render as usual; `createAuthorization` is never called; `detect` false or no `localSignIn` → `OAuthLocalSignInUnavailableError`; `read` throw → `OAuthLocalSignInInvalidError`; when the adapter has `write`, the discovery port from `inMemoryCredentialPort` is wrapped with `linkLocalSignInCredentials` (`account: () => ({ linked: true, expiresAt: current metadata expiresAt })`); the staged account carries `localSignIn: true`.

- [ ] **Step 1: Failing tests** — `stores the read credential and marks the account`; `never creates an authorization port`; `fails with OAUTH_LOCAL_SIGN_IN_UNAVAILABLE when detect is false without calling read`; `a read failure surfaces OAUTH_LOCAL_SIGN_IN_INVALID with no cause`; `an expired host credential refreshed during discovery is written back to the host` (Review Focus 4); `browser re-login of a marked Provider clears the marker`; `existing accounts read as unmarked after migration`.
- [ ] **Step 2: Run** `bun test packages/core/src/plugins/account-login/local-sign-in.test.ts` — FAIL.
- [ ] **Step 3: Implement** (keep `login.ts` ≤ 400 lines).
- [ ] **Step 4: Run** `bun test packages/core` — PASS.
- [ ] **Step 5: Commit** `feat(core): link a Provider account to a local sign-in`.

### Task 4: Server runtime wiring and summary

**Files:**
- Modify: `packages/server/src/plugin-account.ts` — when `account.localSignIn === true && adapter.localSignIn?.write !== undefined`, wrap both credential factories with `linkLocalSignInCredentials` (`account: () => { const a = repository.readAccount(config.id); return a && { linked: a.localSignIn === true, ...(a.expiresAt === undefined ? {} : { expiresAt: a.expiresAt }) }; }`); `OAuthAccountSummary.localSignInSource?: LocalizedText` when marked and the adapter has `localSignIn`
- Modify: `packages/server/src/plugin-runtime/catalog.ts` `summary(...)` persisted input + mapping; its callers in `plugin-runtime/materialize.ts`
- Modify: `packages/types/src/dashboard/dashboard.ts` — `DashboardProviderSummarySchema.localSignInSource: DashboardLocalizedTextSchema.optional()`
- Move: `plugin-account.ts` → `packages/server/src/plugin-account/{index.ts,plugin-account.ts}` (import paths unchanged via `index.ts`); Test: `plugin-account/plugin-account.test.ts`
- `onWriteFailed` logs event `plugin.local_sign_in.write_failed` with `{ providerId }` only, no error object

- [ ] **Step 1: Failing tests** — `a marked account's runtime refresh writes back to the host`; `an unmarked account never calls read or write`; `summary carries localSignInSource for ready, disabled, and unavailable states`.
- [ ] **Step 2: Run** `bun test packages/server/src/plugin-account packages/server/src/plugin-runtime` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** plus `bun test packages/server/src/credential-refresh packages/server/src/oauth-account-context` — PASS.
- [ ] **Step 5: Commit** `feat(server): sync linked accounts with the host sign-in at runtime`.

### Task 5: ChatGPT plugin against Codex's store

**Files:**
- Create: `packages/plugins/openai-chatgpt/src/local-sign-in/{index.ts,codex-store.ts,codex-store.test.ts}`
- Modify: `schema.ts` (`ChatGPTCredential.idToken?: string`), `oauth-flow.ts` (`toCredential` keeps `id_token`, falls back to the previous `idToken` on refresh), `plugin/plugin.ts` (credential zod `idToken` optional; adapter `localSignIn`), presentation text `source: 'Codex'`

**Interfaces — Produces:**
```ts
export function codexHome(env?: Record<string, string | undefined>): string; // CODEX_HOME or ~/.codex
export function createCodexLocalSignIn(input?: { readonly home?: () => string; readonly now?: () => number }): OAuthLocalSignIn<Record<string, unknown>, ChatGPTCredential>;
export class CodexSignInInvalidError extends Error; // 'Codex local sign-in is invalid or incomplete', never a cause
```
- `detect`: `Bun.file(join(home, 'auth.json')).exists()`.
- `read`: `isPlainObject` + zod; `auth_mode` absent or `/^chatgpt/` (reject `apikey`); `tokens.access_token`, `tokens.refresh_token` required; `id_token`, `account_id` optional. `expiresAt` from the access-token JWT `exp`. Same `fingerprint`/`suggestedKey`/`accountLabel` as browser login.
- `write(ctx, next, previous)`: `realpath`; re-read; if not parseable or `tokens.refresh_token !== previous.refreshToken` → return; replace `tokens.{access_token,refresh_token,id_token,account_id}` and `last_refresh` (ISO from `now`); write `.auth.json.<uuid>.tmp` in the same dir with mode `0o600`; `rename`.

- [ ] **Step 1: Failing tests** (temp `CODEX_HOME`):
  - `detect is false when auth.json is absent`; `detect is true for an unreadable (chmod 000) file`
  - `read rejects malformed JSON, missing tokens, and apikey mode with leftover tokens; error message/stack contain no fixture value` (Review Focus 1)
  - `read matches browser login fingerprint and reports JWT expiry`
  - `write preserves auth_mode, OPENAI_API_KEY, unknown fields, sets last_refresh, keeps 0600`
  - `write skips when the host refresh token no longer equals previous` (Review Focus 3)
  - `write through a symlink updates the target and keeps the link` (Review Focus 2)
  - `refresh keeps the previous id_token when the response omits it`
- [ ] **Step 2: Run** `bun test packages/plugins/openai-chatgpt/src/local-sign-in` — FAIL.
- [ ] **Step 3: Implement** and wire into the adapter.
- [ ] **Step 4: Run** `bun test packages/plugins/openai-chatgpt` — PASS.
- [ ] **Step 5: Commit** `feat(openai-chatgpt): reuse the Codex sign-in on this machine`.

### Task 6: GitHub Copilot plugin against its local store

**Files:**
- Create: `packages/plugins/github-copilot/src/local-sign-in/{index.ts,copilot-store.ts,copilot-store.test.ts}`
- Modify: `src/plugin.ts` (adapter `localSignIn`, source `'GitHub Copilot'`), `src/github-api/login.ts` (extract `completeGitHubCopilotLogin(githubToken: string, options: GitHubAccountOptions, context: { signal: AbortSignal; fetch?: RuntimeFetch; progress?: (m: LocalizedText) => void })` used by both flows)

**Interfaces — Produces:**
```ts
export function copilotConfigDir(env?: Record<string, string | undefined>): string; // $XDG_CONFIG_HOME/github-copilot or ~/.config/github-copilot
export function createCopilotLocalSignIn(input?: { readonly dir?: () => string }): OAuthLocalSignIn<GitHubAccountOptions, GitHubCopilotCredential>;
```
- `detect`: `apps.json` or `hosts.json` exists.
- `read`: host = `new URL(enterpriseURL).host` or `github.com`; candidates from `apps.json` keys `<host>:<appId>` then `hosts.json` key `<host>` with non-empty string `oauth_token`; prefer appId equal to the plugin client id; none → `CopilotSignInInvalidError('GitHub Copilot local sign-in is invalid or incomplete')`; then `completeGitHubCopilotLogin`.
- No `write`.

- [ ] **Step 1: Failing tests** (temp dir, stubbed fetch): `detect false with neither file`; `prefers the apps.json entry for the plugin client id`; `falls back to hosts.json`; `Enterprise options with only a github.com entry fail cleanly with no token in the error` (Review Focus 5); `malformed JSON fails cleanly`; `result shape matches device-flow login (fingerprint = user id)`.
- [ ] **Step 2: Run** `bun test packages/plugins/github-copilot/src/local-sign-in` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test packages/plugins/github-copilot` — PASS.
- [ ] **Step 5: Commit** `feat(github-copilot): reuse the Copilot sign-in on this machine`.

### Task 7: Dashboard API surface and removal guarantee

**Files:**
- Modify: `packages/types/src/dashboard-oauth.ts` — `DashboardOAuthCapabilitySchema.localSignIn: z.strictObject({ source: DashboardLocalizedTextSchema }).optional()`; `DashboardOAuthSessionStartSchema.localSignIn: z.boolean().default(false)`
- Modify: `packages/server/src/dashboard-routes/oauth-capabilities.ts` — `dashboardOAuthCapabilities(registry): Promise<readonly DashboardOAuthCapability[]>`; each `detect` gets a 2 s `AbortSignal.timeout`; throw/timeout → omitted
- Modify: `packages/server/src/server-state/oauth-views.ts` and `server-state/types.ts` (`oauthCapabilities` returns a Promise; await detection inside the `try` so the snapshot lease is held until detection settles); `dashboard-routes/config.ts` awaits it
- Modify: `packages/server/src/oauth-login-session/manager.ts` — pass `localSignIn: input.localSignIn`
- Test: `packages/server/src/dashboard-routes/oauth-capabilities.test.ts` (new colocated dir if the file is moved), new case in `packages/server/__tests__/account-removal/finalize.test.ts`

- [ ] **Step 1: Failing tests** — `capabilities omit localSignIn when detect is false, throws, or times out`; `capabilities include localSignIn.source when detect is true`; `the snapshot lease is released only after detection settles`; `a session started with localSignIn succeeds without an authorization step and reports OAUTH_LOCAL_SIGN_IN_INVALID on a bad store`; `removing a linked Provider leaves the host store bytes unchanged and never calls write`.
- [ ] **Step 2: Run** `bun test packages/server` (affected dirs) — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(server): expose local sign-in detection and linking to the dashboard`.

### Task 8: Dashboard entry point and badge

Follow `packages/dashboard/AGENTS.md`.

**Files:**
- Modify: `components/provider-editor/connection-section/connection-section.tsx` (Create) and the Edit-mode reauthorize component it hands off to — when the capability has `localSignIn`, an outline button `data-testid="connection-local-sign-in"` labelled `dashboard.providers.oauth.use_local_sign_in({ source })`, opening a confirm dialog (`…local_sign_in_confirm_title` / `…_description`: aio-proxy reads the sign-in {source} keeps on this machine and keeps it in sync; removing the Provider will not sign {source} out)
- Modify: `templates/provider-editor-page/use-provider-editor-page.ts` — a `localSignIn` path for create and reauthorize that does **not** call `openPopup()`; `use-oauth-editor-session.ts` / `services/oauth-service.ts` pass `localSignIn: true`
- Modify: Provider card + delete confirmation — badge `dashboard.providers.local_sign_in_badge({ source })`, note `dashboard.providers.local_sign_in_delete_note({ source })`
- Modify: `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`

- [ ] **Step 1: Failing tests** — `local sign-in button is absent without capability.localSignIn`; `confirming in Create starts a session with localSignIn true and does not call window.open`; `the same from Edit reauthorizes the existing Provider`; `cancel starts nothing`; `linked card shows the badge and the delete dialog shows the note`.
- [ ] **Step 2: Run** `bun run --filter @aio-proxy/dashboard test` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(dashboard): offer the sign-in already on this machine`.

### Task 9: CLI equivalent

**Files:**
- Modify: `packages/cli/src/plugin-commands/provider-login/index.ts` (`ProviderLoginOptions.localSignIn?: boolean`), `deps.ts` (method chooser), `presentation.ts` (map `OAuthLocalSignInUnavailableError` / `OAuthLocalSignInInvalidError` to localized user errors), the `provider login` command definition (`--local-sign-in`)
- Modify: `packages/i18n/messages/*.json` — `cli.provider_login.method_prompt`, `cli.provider_login.method_local({ source })`, `cli.provider_login.method_browser`, error messages
- Test: `packages/cli/src/plugin-commands/provider-login/login.test.ts`

Behavior: `--local-sign-in` → `loginOAuthAccount({ …, localSignIn: true })`, skipping the method question; account options still render as for browser login (prompts need a TTY when the form has visible fields, same as today). Without the flag on a TTY, if the adapter has `localSignIn` and `detect` is true, ask browser vs local. Non-TTY without the flag never calls `detect`.

- [ ] **Step 1: Failing tests** — `--local-sign-in links without creating authorization`; `TTY method prompt appears only when detect is true`; `non-TTY without the flag never calls detect`; `nothing detected prints the localized unavailable error`.
- [ ] **Step 2: Run** `bun test packages/cli/src/plugin-commands/provider-login` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(cli): provider login --local-sign-in`.

### Task 10: Docs, changeset, follow-up issue, verification

- [ ] **Step 1:** README.md + README.zh-Hans.md: short subsection "Reuse a sign-in already on this machine" (Codex, GitHub Copilot; containers show no option; recovery = use local sign-in again on the Provider). Website Providers page, all locales present there.
- [ ] **Step 2:** `.changeset/local-sign-in.md` targeting `aio-proxy` and every internal package touched (exact names from each `package.json`), all `minor`. Body: ChatGPT and GitHub Copilot Providers can use the sign-in Codex or Copilot already keeps on this machine instead of a browser login; aio-proxy keeps Codex signed in when it refreshes, and removing the Provider never signs the tool out.
- [ ] **Step 3:** `bun run preflight` — must pass; report actual output.
- [ ] **Step 4:** Manual end-to-end (ask the user first; it performs a real refresh on their account): link ChatGPT via Codex, route one request, trigger a manual credential refresh, run `codex exec "say ok"` and confirm Codex works; remove the Provider and confirm the removal did not change `~/.codex/auth.json` (compare hash before/after removal only).
- [ ] **Step 5:** `gh issue create --repo aio-proxy/aio-proxy` for Claude Code (Keychain read/write, OS prompt, whether Claude Code reloads before refreshing), referencing #475.
- [ ] **Step 6: Commit** `docs: local sign-in reuse`.
