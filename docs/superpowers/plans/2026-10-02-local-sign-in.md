# Local Sign-In Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a subscription Provider reuse the sign-in a vendor tool already keeps on this machine (Codex, GitHub Copilot) instead of a browser OAuth round trip.

**Architecture:** An optional `localSignIn` capability on `OAuthAdapter` (detect / read / optional write). `loginOAuthAccount` gains a `localSignIn` switch that replaces the authorization step with `read`, and marks the stored account. For marked accounts whose adapter implements `write`, the server wraps the credential port so every refresh first adopts the host store's credential and writes the rotated result back before the framework's compare-and-swap.

**Tech Stack:** Bun, TypeScript, zod, drizzle (SQLite migrations), Hono, React + TanStack Query, es-toolkit.

**Spec:** `docs/superpowers/specs/2026-10-02-local-sign-in-design.md`

## Global Constraints

- Host stores are read only after an explicit user action per account; `detect` checks presence only and never parses or returns secrets.
- No server code branches on a bundled plugin's identity; everything goes through `adapter.localSignIn`.
- Removing a Provider never calls `write` and leaves host store bytes unchanged.
- No value read from a host store appears in logs, traces, diagnostics, error messages, or test snapshots.
- Tests use temporary directories (`CODEX_HOME`, `XDG_CONFIG_HOME`); never touch the real `~/.codex` or `~/.config/github-copilot`.
- `isPlainObject` (es-toolkit/predicate) for parsed host-store JSON; `isRecord` (`@aio-proxy/shared`) for the adapter contract in the registry.
- SDK change is additive only (rebases over #476's quota-scope change in the same file).
- Non-test implementation files ≤ 500 lines; tests colocated in same-name directories.
- Changesets: one targeting `@aio-proxy/plugin-sdk` (minor); one targeting `aio-proxy` plus every internal package touched (minor). One short paragraph each.

## Review Focus

1. `auth.json` with `auth_mode: "apikey"` or `tokens: null` (API-key Codex login) — read must fail with the generic "local sign-in is invalid or incomplete" error, not crash or leak. Test in Task 4.
2. `auth.json` is a symlink (dotfile managers) — write-back must replace the target's contents, not the link. Test in Task 4.
3. Codex signs in to a different ChatGPT account after linking — refresh must fail non-retryably with a re-link diagnostic and must not write the host store. Test in Task 3.
4. Copilot linked with Enterprise options while the host store only has `github.com` — read fails cleanly naming no token. Test in Task 5.
5. A browser re-login on a linked Provider — the marker is cleared and later refreshes never touch the host store. Test in Task 2.

---

### Task 1: SDK capability and registry validation

**Files:**
- Modify: `packages/plugin-sdk/src/oauth.ts` (add types after `OAuthCredentialImporter`, add field to `OAuthAdapter`)
- Modify: `packages/core/src/plugins/registry.ts` (validate and bind `localSignIn` next to `validateCredentialImports`)
- Test: `packages/core/src/plugins/registry.test.ts` (or the existing colocated registry test; move from `_test/` if that is where it lives)
- Create: `.changeset/plugin-sdk-local-sign-in.md`
- Modify: plugin SDK docs (`packages/plugin-sdk/README.md` and the website plugin-SDK page)

**Interfaces:**
- Produces:
  ```ts
  export type OAuthLocalSignInContext = { readonly signal: AbortSignal };
  export type OAuthLocalSignIn<AccountOptions, Credential> = {
    readonly source: LocalizedText;
    readonly detect: (context: OAuthLocalSignInContext) => Promise<boolean>;
    readonly read: (context: OAuthCredentialImportContext, options: AccountOptions) => Promise<OAuthLoginResult<Credential>>;
    readonly write?: (context: OAuthLocalSignInContext, credential: Credential) => Promise<void>;
  };
  // OAuthAdapter: readonly localSignIn?: OAuthLocalSignIn<AccountOptions, Credential>;
  ```
  JSDoc on `detect`: presence only, must not read secrets. On `write`: implement only when the host store rotates refresh tokens; its presence makes the host store the source of truth on every refresh.

- [ ] **Step 1: Failing tests** — `registers an adapter with localSignIn and keeps its methods bound`; `rejects localSignIn without detect/read functions or with a non-LocalizedText source` (expects `Error('Invalid OAuth adapter')`); `rejects a non-function write`.
- [ ] **Step 2: Run** `bun test packages/core/src/plugins/registry` — FAIL.
- [ ] **Step 3: Implement** the types and `validateLocalSignIn(value: unknown)` in `registry.ts`, mirroring `validateCredentialImports` (`isRecord`, bind each method to the object).
- [ ] **Step 4: Run** the same tests — PASS.
- [ ] **Step 5: Docs + changeset** — SDK docs section "Using a sign-in already on this machine" covering detect/read/write semantics and the rotation rule; changeset body: plugins can now offer a vendor tool's existing local sign-in as an alternative to the browser flow.
- [ ] **Step 6: Commit** `feat(plugin-sdk): optional local sign-in capability on OAuthAdapter`.

### Task 2: Account marker and local-sign-in login path in core

**Files:**
- Modify: `packages/core/src/db/schema/plugin-oauth.ts` — `localSignIn: integer('local_sign_in', { mode: 'boolean' }).notNull().default(false)` on `oauthAccount`
- Create: migration via `bunx drizzle-kit generate` in `packages/core`, then `bun run build:migrations` (regenerates `migrations.manifest.ts`)
- Modify: `packages/core/src/plugins/repository/{types.ts,rows.ts,accounts.ts}` — `StoredAccount.localSignIn?: true`; `AccountWrite.localSignIn?: true`; insert/update write `local_sign_in`
- Modify: `packages/core/src/plugins/account-login/login.ts` and `login/stage.ts` (`buildAccountWrite` passes the flag through `StageContext`)
- Modify: `packages/core/src/plugins/account-login/errors.ts` — `OAuthLocalSignInUnavailableError(plugin, capability)` with message `OAUTH_LOCAL_SIGN_IN_UNAVAILABLE`
- Test: `packages/core/src/plugins/account-login/local-sign-in.test.ts` (uses existing `test-support.ts`)

**Interfaces:**
- Consumes: `OAuthLocalSignIn` (Task 1).
- Produces: `LoginOAuthAccountOptions.localSignIn?: boolean`. When true, `createAuthorization` is never called; the adapter's `localSignIn.read(context, parsedOptions)` runs under the same deadline; the result goes through `persistOAuthAccount` with the account marked. Throws `OAuthLocalSignInUnavailableError` if the adapter has no `localSignIn` or `detect` returns false. `StoredAccount.localSignIn` is `true` only for marked accounts.

- [ ] **Step 1: Failing tests** — `local sign-in login stores the read credential and marks the account`; `never creates an authorization port`; `fails with OAUTH_LOCAL_SIGN_IN_UNAVAILABLE when detect is false and does not call read`; `browser re-login of a marked Provider clears the marker` (Review Focus 5); `migrated database reads existing accounts as unmarked`.
- [ ] **Step 2: Run** `bun test packages/core/src/plugins/account-login/local-sign-in.test.ts` — FAIL.
- [ ] **Step 3: Implement** schema column, migration, repository fields, and the `localSignIn` branch in `loginOAuthAccount` (keep `login.ts` under 400 lines; extract the read call into `login/local-sign-in.ts` if it does not fit).
- [ ] **Step 4: Run** the new tests plus `bun test packages/core/src/db packages/core/src/plugins` — PASS.
- [ ] **Step 5: Commit** `feat(core): link a Provider account to a local sign-in`.

### Task 3: Host-store-as-source-of-truth refresh in the server

**Files:**
- Create: `packages/server/src/local-sign-in/index.ts`, `local-sign-in.ts`, `local-sign-in.test.ts`
- Modify: `packages/server/src/plugin-account.ts` — wrap `createCredentials` when `account.localSignIn === true && adapter.localSignIn?.write !== undefined`; add `localSignInSource?: LocalizedText` to `OAuthAccountSummary` when the account is marked and the adapter has `localSignIn`

**Interfaces:**
- Consumes: `StoredAccount.localSignIn`, `OAuthLocalSignIn`.
- Produces:
  ```ts
  export function linkLocalSignInCredentials(
    port: CredentialPort<unknown>,
    link: { readonly localSignIn: OAuthLocalSignIn<unknown, unknown>; readonly options: unknown; readonly fingerprint: string },
  ): CredentialPort<unknown>;
  export class LocalSignInAccountChangedError extends CredentialRefreshError; // retryable: false, reason: 'local_sign_in_account_changed'
  ```
  `read` passes through. `refresh(rev, exchange)` delegates to `port.refresh(rev, wrapped)` where `wrapped(current, signal)`: `host = await read({signal, progress: noop}, options)`; if `host.fingerprint !== fingerprint` throw `LocalSignInAccountChangedError`; `result = await exchange({ ...current, value: host.credentials }, signal)`; `await write({signal}, result.value)`; return `result`. Running inside `exchange` puts host sync and write-back inside the framework lease and before its CAS.

- [ ] **Step 1: Failing tests** (fake `localSignIn` backed by a temp JSON file, fake exchange that rotates `refreshToken` and records the token it was given):
  - `refresh uses the host store's refresh token when the host tool refreshed first` — exchange receives the host token, not the stale mirror.
  - `refresh writes the rotated credential back before the mirror is updated` — host file holds the new token; a write that throws leaves the mirror revision unchanged.
  - `refresh fails non-retryably when the host store holds a different account and does not write` (Review Focus 3).
  - `browser-login accounts never read or write the host store` — unmarked account through `prepareOAuthPluginAccount`, spies show zero calls.
  - `refresh failure log contains no host-store value` — capture logger output, assert none of the fixture token strings appear.
- [ ] **Step 2: Run** `bun test packages/server/src/local-sign-in` — FAIL.
- [ ] **Step 3: Implement** `linkLocalSignInCredentials` and the wiring in `plugin-account.ts` (file stays ≤ 230 lines).
- [ ] **Step 4: Run** the tests plus `bun test packages/server/src/credential-refresh packages/server/src/oauth-account-context` — PASS.
- [ ] **Step 5: Commit** `feat(server): keep linked accounts in sync with the host sign-in`.

### Task 4: ChatGPT plugin against Codex's store

**Files:**
- Create: `packages/plugins/openai-chatgpt/src/local-sign-in/index.ts`, `codex-store.ts`, `codex-store.test.ts`
- Modify: `packages/plugins/openai-chatgpt/src/schema.ts` (`ChatGPTCredential.idToken?: string`), `oauth-flow.ts` (`toCredential` keeps `id_token`), `plugin/plugin.ts` (credential zod gets `idToken: zod.string().optional()`; adapter gets `localSignIn`)
- Modify: plugin i18n presentation text for `source` ("Codex" in all locales)

**Interfaces:**
- Produces:
  ```ts
  export function codexHome(env?: Record<string, string | undefined>): string; // CODEX_HOME or ~/.codex
  export function createCodexLocalSignIn(input: { readonly home?: () => string; readonly now?: () => number }): OAuthLocalSignIn<Record<string, unknown>, ChatGPTCredential>;
  export class CodexSignInInvalidError extends Error; // message: 'Codex local sign-in is invalid or incomplete'
  ```
  - `detect`: `Bun.file(path).exists()` on `<home>/auth.json`.
  - `read`: parse JSON (`isPlainObject`), zod `{ tokens: { access_token, refresh_token, id_token?, account_id? } }`, any failure → `CodexSignInInvalidError` (never wraps the parse error). `accountId` from `account_id` ?? JWT; `expiresAt` from the access-token JWT `exp`; email from id_token. Returns the same `fingerprint`/`suggestedKey`/`accountLabel` shape as browser login.
  - `write`: resolve `realpath`, re-read the file, replace only `tokens.{access_token,refresh_token,id_token,account_id}` and `last_refresh` (ISO string from `now`), write `<dir>/.auth.json.<random>.tmp` with mode `0o600`, `rename` over the real path.

- [ ] **Step 1: Failing tests** (temp `CODEX_HOME`):
  - `detect is false when auth.json is absent` (and `read` is never needed for that answer).
  - `detect does not read file contents` — make the file unreadable (`chmod 000`), `detect` still resolves true.
  - `read rejects malformed JSON, API-key logins, and missing tokens with CodexSignInInvalidError whose message and cause contain no file content` (Review Focus 1).
  - `read returns the same fingerprint as browser login for the same account`.
  - `write keeps auth_mode, OPENAI_API_KEY, and unknown fields, updates tokens and last_refresh, and leaves mode 0600`.
  - `write through a symlinked auth.json updates the target and keeps the link` (Review Focus 2).
  - `refresh keeps id_token from the token response`.
- [ ] **Step 2: Run** `bun test packages/plugins/openai-chatgpt/src/local-sign-in` — FAIL.
- [ ] **Step 3: Implement** the store module and wire `localSignIn: createCodexLocalSignIn({})` into the adapter.
- [ ] **Step 4: Run** `bun test packages/plugins/openai-chatgpt` — PASS.
- [ ] **Step 5: Commit** `feat(openai-chatgpt): reuse the Codex sign-in on this machine`.

### Task 5: GitHub Copilot plugin against its local store

**Files:**
- Create: `packages/plugins/github-copilot/src/local-sign-in/index.ts`, `copilot-store.ts`, `copilot-store.test.ts`
- Modify: `packages/plugins/github-copilot/src/plugin.ts` (adapter gets `localSignIn`), `github-api/login.ts` (extract the post-token half of `loginToGitHubCopilot` into `completeGitHubCopilotLogin(githubToken, options, context)` so both paths share it)

**Interfaces:**
- Produces:
  ```ts
  export function copilotConfigDir(env?: Record<string, string | undefined>): string; // $XDG_CONFIG_HOME/github-copilot or ~/.config/github-copilot
  export function createCopilotLocalSignIn(input: { readonly dir?: () => string }): OAuthLocalSignIn<GitHubAccountOptions, GitHubCopilotCredential>;
  ```
  - `detect`: `apps.json` or `hosts.json` exists.
  - `read`: host = `new URL(enterpriseURL).host` or `github.com`. Collect entries from `apps.json` (keys `<host>:<appId>`) then `hosts.json` (key `<host>`) whose `oauth_token` is a non-empty string; prefer the `apps.json` entry whose appId equals the plugin client id; none → `CopilotSignInInvalidError('GitHub Copilot local sign-in is invalid or incomplete')`. Then `completeGitHubCopilotLogin`.
  - No `write` (token does not rotate; copied once).

- [ ] **Step 1: Failing tests** (temp dir, stubbed fetch): `detect false with neither file`; `read prefers apps.json entry for the plugin client id`; `read falls back to hosts.json`; `read with Enterprise options and only a github.com entry fails cleanly with no token in the error` (Review Focus 4); `malformed JSON fails cleanly`; `read result matches device-flow login shape (fingerprint = user id)`.
- [ ] **Step 2: Run** `bun test packages/plugins/github-copilot/src/local-sign-in` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test packages/plugins/github-copilot` — PASS.
- [ ] **Step 5: Commit** `feat(github-copilot): reuse the Copilot sign-in on this machine`.

### Task 6: Server API surface and removal guarantee

**Files:**
- Modify: `packages/types/src/dashboard-oauth.ts` — `DashboardOAuthCapabilitySchema` gets `localSignIn: z.strictObject({ source: LocalizedTextSchema }).optional()`; `DashboardOAuthSessionStartSchema` gets `localSignIn: z.boolean().default(false)` (and refine: `localSignIn` requires `capability` or `targetProviderId`, already covered)
- Modify: `packages/types/src/dashboard/dashboard.ts` — `DashboardProviderSummarySchema.localSignInSource: LocalizedTextSchema.optional()`
- Modify: `packages/server/src/dashboard-routes/oauth-capabilities.ts` — `dashboardOAuthCapabilities` becomes async; runs each adapter's `detect` with a 2 s abort, a throw or timeout counts as false; `config.ts` route awaits it
- Modify: `packages/server/src/oauth-login-session/manager.ts` — pass `localSignIn: input.localSignIn` to `loginOAuthAccount`
- Modify: the summary materializer that maps `OAuthAccountSummary` to `DashboardProviderSummary` (`packages/server/src/plugin-runtime/materialize.ts`) to carry `localSignInSource`
- Test: `packages/server/src/dashboard-routes/oauth-capabilities.test.ts`, `packages/server/src/account-removal.test.ts` (add case; move to `account-removal/` directory per the colocation rule if materially changed)

- [ ] **Step 1: Failing tests** — `capabilities omit localSignIn when detect is false, throws, or times out`; `capabilities include localSignIn.source when detect is true`; `a session started with localSignIn succeeds without an authorization step`; `removing a linked Provider leaves the host store bytes unchanged and never calls write` (temp file, compare bytes before/after).
- [ ] **Step 2: Run** `bun test packages/server/src/dashboard-routes packages/server/src/account-removal packages/server/src/oauth-login-session` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same — PASS; `bun run --filter @aio-proxy/types test` — PASS.
- [ ] **Step 5: Commit** `feat(server): expose local sign-in detection and linking to the dashboard`.

### Task 7: Dashboard entry point and badge

Follow `packages/dashboard/AGENTS.md`.

**Files:**
- Modify: `packages/dashboard/src/modules/providers/components/provider-editor/connection-section/connection-section.tsx` — beside `connection-authorize`, when `selected.localSignIn` exists, an outline button `data-testid="connection-local-sign-in"` labelled `dashboard.providers.oauth.use_local_sign_in({ source })`; clicking opens a confirm dialog (`dashboard.providers.oauth.local_sign_in_confirm_title` / `_description`: aio-proxy will read the sign-in {source} keeps on this machine and keep it in sync; removing the Provider will not sign {source} out)
- Modify: `use-oauth-editor-session.ts` / `services/oauth-service.ts` — start a session with `localSignIn: true`
- Modify: the Provider card component and the delete confirmation — badge `dashboard.providers.local_sign_in_badge({ source })`; delete dialog adds `dashboard.providers.local_sign_in_delete_note({ source })`
- Modify: `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`
- Test: colocated tests next to `connection-section.tsx` and the card

- [ ] **Step 1: Failing tests** — `local sign-in button is absent when the capability has no localSignIn`; `confirming starts a session with localSignIn true and the account fields`; `cancel starts nothing`; `linked Provider card shows the badge`.
- [ ] **Step 2: Run** `bun run --filter @aio-proxy/dashboard test` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same — PASS.
- [ ] **Step 5: Commit** `feat(dashboard): offer the sign-in already on this machine`.

### Task 8: CLI equivalent

**Files:**
- Modify: `packages/cli/src/plugin-commands/provider-login/index.ts` (`ProviderLoginOptions.localSignIn?: boolean`), `deps.ts` (interactive chooser), the command registration that defines `provider login` flags (`--local-sign-in`)
- Modify: `packages/i18n/messages/*.json` — `cli.provider_login.method_prompt`, `cli.provider_login.method_local({ source })`, `cli.provider_login.method_browser`
- Test: `packages/cli/src/plugin-commands/provider-login/login.test.ts`

**Interfaces:**
- `--local-sign-in` → call `loginOAuthAccount({ ..., localSignIn: true })`; detect false → existing user-error presentation of `OAUTH_LOCAL_SIGN_IN_UNAVAILABLE` with a localized message.
- Without the flag, on a TTY, if `adapter.localSignIn` exists and `detect` is true, ask browser vs local; non-TTY without the flag keeps the browser flow.

- [ ] **Step 1: Failing tests** — `--local-sign-in links without creating authorization`; `TTY prompt appears only when detect is true`; `non-TTY without the flag never calls detect`; `--local-sign-in when nothing is detected prints the localized error`.
- [ ] **Step 2: Run** `bun test packages/cli/src/plugin-commands/provider-login` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(cli): provider login --local-sign-in`.

### Task 9: Docs, changeset, follow-up issue, verification

- [ ] **Step 1:** README.md + README.zh-Hans.md: one short subsection under subscription Providers ("Reuse a sign-in already on this machine": Codex, GitHub Copilot; Docker shows no option). Website docs: same on the Providers page (all locales present there).
- [ ] **Step 2:** `.changeset/local-sign-in.md` targeting `aio-proxy`, `@aio-proxy/core`, `@aio-proxy/server`, `@aio-proxy/cli`, `@aio-proxy/dashboard`, `@aio-proxy/types`, `@aio-proxy/i18n`, `@aio-proxy/plugin-openai-chatgpt`, `@aio-proxy/plugin-github-copilot` (use the exact package names from each `package.json`), all `minor`. Body: ChatGPT and GitHub Copilot Providers can now use the sign-in Codex or Copilot already keeps on this machine instead of a browser login; aio-proxy keeps Codex's sign-in valid when it refreshes, and removing the Provider never signs the tool out.
- [ ] **Step 3:** `bun run preflight` — must pass; report the actual output.
- [ ] **Step 4:** Manual end-to-end (requires the user's consent; it performs a real refresh on their account): link ChatGPT via Codex, route one request, trigger a manual credential refresh, then run `codex exec "say ok"` and confirm Codex still works; remove the Provider and confirm `~/.codex/auth.json` is unchanged by the removal.
- [ ] **Step 5:** File the Claude Code follow-up issue (Keychain read/write, OS prompt, whether Claude Code reloads on refresh) with `gh issue create --repo aio-proxy/aio-proxy`, referencing #475.
- [ ] **Step 6: Commit** `docs: local sign-in reuse`.
