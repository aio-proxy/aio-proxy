# Cursor OAuth quota reporting

Date: 2026-09-03

## Problem

`@aio-proxy/plugin-cursor` registers an `OAuthAdapter` without a `quota` capability. `prepareOAuthPluginAccount` (`packages/server/src/plugin-account.ts:119`) sets `DashboardProviderSummary.hasQuota` from `adapter.quota !== undefined`, so the Cursor Provider card renders no quota ring while ChatGPT, Kimi, and xAI Grok do.

Cursor exposes account usage on `cursor.com`, but those endpoints are **cookie-authenticated**, not `Authorization: Bearer`. That is the only structural difference from the three existing readers.

## Goals

- `adapter.quota.read` returns a `OAuthQuotaSnapshot` that survives `validateOAuthQuotaSnapshot` (`packages/core/src/plugins/quota.ts`).
- The ring shows the monthly plan lanes plus the weekly Grok Bot allowance, with the billing-cycle end as `resetsAt`.
- No new credential material. The cookie is derived from the access token we already store.
- One required upstream call. Everything else is best-effort enrichment that cannot fail the read.

## Non-goals

CodexBar is a macOS menu-bar app reading a local Cursor.app install. A server-side proxy has none of that context. The following are **explicitly out of scope and must not be ported**, now or later:

- Cursor.app's local `state.vscdb` SQLite session (`cursorAuth/accessToken`, WAL sidecars, UTF-16LE BLOB decoding).
- Browser cookie import (Safari `Cookies.binarycookies`, Chrome `Cookies`, Firefox `cookies.sqlite`) and the cookie-source ladder.
- The interactive external-browser Add / Switch Account flow and `authenticator.cursor.sh` polling.
- The local CSV reader and the token-cost `get-filtered-usage-events` pagination.
- Manual pasted `Cookie:` headers as a configurable provider option.

aio-proxy already owns a real Cursor OAuth login (`packages/plugins/cursor/src/oauth/oauth.ts`) that yields an access token with a `sub` claim. Everything the usage endpoints need follows from that token. There is no user-visible gap that a cookie jar would close.

Also out of scope: `OAuthQuotaCapability.reset`. Cursor has no redeem / reset-credit endpoint, so `quota.reset` stays `undefined` and `OAuthQuotaSnapshot.resetCredits` is never populated.

## Prior art

CodexBar (`.reference/CodexBar/Sources/CodexBarCore/Providers/Cursor/`) is the only prior art for Cursor usage reporting. The comparable server-side quota UI, the CLI-Proxy-API Management Center (`router-for-me/Cli-Proxy-API-Management-Center`), does **not** support Cursor at all — its providers are Gemini, Codex, Claude, Vertex, Antigravity, Kimi, and xAI/Grok, and its Quota Management page lists the same set. Field names and precedence rules below therefore come from the Swift source, verified file by file, not from a second independent implementation.

## Authentication

`CursorAppAuthSession.cookieHeader()` (`CursorAppAuth.swift:143-155`):

```swift
func cookieHeader() throws -> String {
    try "WorkosCursorSessionToken=\(self.userID())%3A%3A\(self.accessToken)"
}

func userID() throws -> String {
    let json = try self.payload()
    guard let subject = json["sub"] as? String,
          let userID = subject.split(separator: "|", omittingEmptySubsequences: true).last.map(String.init),
          !userID.isEmpty
    else { throw ... }
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))
    guard userID.unicodeScalars.allSatisfy(allowed.contains) else { throw ... }
    return userID
}
```

Three load-bearing details:

1. **The user id is the last non-empty `|`-separated segment of the JWT `sub` claim.** `auth0|user_01ABC` -> `user_01ABC`. A `sub` with no `|` is used whole. `omittingEmptySubsequences: true` means a trailing `|` is ignored, so the JS split must drop empty segments before taking the last one — a naive `split('|').at(-1)` returns `''` for `user_01ABC|` and produces a silent 401.
2. **The separator is sent as the literal seven-byte sequence `%3A%3A`**, not `::`. `CursorAppAuthSession.from(cookieHeader:)` percent-decodes before splitting on `::`, which confirms cursor.com stores the value percent-encoded. We send the exact byte sequence `WorkosCursorSessionToken=<userId>%3A%3A<accessToken>` in a `Cookie` header, with no further encoding of either part. The access token is a JWT (`[A-Za-z0-9_-]` and `.`), so nothing else in the value needs escaping.
3. **The user id is charset-validated** against `[A-Za-z0-9._-]`. Keep that guard: it turns a malformed claim into a clear local error instead of an opaque upstream 401.

### Where `sub` comes from

`cursorIdentity` (`packages/plugins/cursor/src/jwt/jwt.ts:22-44`) reads the trimmed `sub` claim and `oauth.ts:90` persists it as the optional `subject` field on `CursorCredential`. `subject` is optional in `schema.ts`, and credentials stored before that field existed do not carry it.

**Decision: derive the user id from the current access token's `sub` claim at read time, and fall back to `credential.subject` only when the token has no usable claim.** `readCursorClaims` already exists and is already used on the runtime path, so this is one call. Deriving from the token is self-healing: it works for pre-`subject` credentials, and it cannot go stale when `refreshCursorCredential` rotates the access token. The stored `subject` stays as a fallback for the (unobserved) case of a token that omits `sub`. If neither yields a usable id, the read throws — the ring shows an error rather than a wrong-account number.

This is the single biggest risk in the feature, and it resolves to "existing accounts work with no re-login".

### Refresh before use

**Decision: yes.** The cookie carries the access token, so an expired token is a 401. `readCursorQuota` calls `currentCursorCredential(context.credentials, { fetch, signal })` (`packages/plugins/cursor/src/oauth/credential.ts:57`) exactly as `readOpenAIChatGPTQuota` calls `currentCredential`. That helper already handles the read / expiry-check / `port.refresh` idiom and revision races.

## Endpoints

**Decision: two calls. One required, one best-effort.** A dashboard refresh pays this latency per Provider card, so every endpoint has to earn its place.

| Endpoint | Kept | Reason |
| --- | --- | --- |
| `GET https://cursor.com/api/usage-summary` | yes, required | The only source of plan percentages, the on-demand cap, and the billing-cycle window. Everything on the ring except Grok Bot comes from this one response. |
| `POST https://cursor.com/api/dashboard/get-sand-usage-status` | yes, best-effort | Grok Bot's weekly allowance is a genuinely separate window with its own reset; nothing in `usage-summary` reports it. Given its own timeout and swallowed failures. |
| `GET https://cursor.com/api/auth/me` | **no** | It returns `sub`, `email`, `name`. We already hold `sub` (from the token) and `email` (on the credential and as the account label). A round trip that tells us what we already know is pure latency. |
| `GET https://cursor.com/api/usage?user=<id>` | **no** | Legacy request-count plans only. CodexBar itself wraps it in `try?` and notes "not all plans have this endpoint". Deliberate ceiling: on a legacy request-based plan the ring reflects `usage-summary` percentages, which on those plans are meaningless or zero. Add this call only if a user reports a permanently full ring. |

`usage-summary` and `get-sand-usage-status` run concurrently under `Promise.all`; the Grok read resolves to `undefined` on any failure, so `Promise.all` never rejects because of it.

Request shape:

- `usage-summary`: `GET`, `Accept: application/json`, `Cookie: <session cookie>`.
- `get-sand-usage-status`: `POST`, body `{}`, `Accept: application/json`, `Content-Type: application/json`, **`Origin: https://cursor.com`** (CSRF gate — omitting it fails the call), `Cookie: <session cookie>`.

Both fetches carry `aioProxy: { traffic: 'control' }`, matching every other control-plane call in this plugin.

## Snapshot mapping

`OAuthQuotaItem` is `{ id, displayName, remainingRatio?, resetsAt? }`. Cursor reports *used*, so every ratio is inverted.

### Field sources (`CursorStatusProbe.swift:230-300`, `:1610-1700`)

| Item id | Source | `displayName` |
| --- | --- | --- |
| `plan` | `individualUsage.plan.totalPercentUsed`, with the fallback ladder below | `{ default: 'Plan usage', 'zh-Hans': '套餐用量' }` |
| `auto` | `individualUsage.plan.autoPercentUsed` | `{ default: 'Auto models', 'zh-Hans': 'Auto 模型' }` |
| `api` | `individualUsage.plan.apiPercentUsed` | `{ default: 'Named models', 'zh-Hans': '指定模型' }` |
| `on-demand` | `individualUsage.onDemand.used / .limit` (cents) | `{ default: 'On-demand budget', 'zh-Hans': '按量预算' }` |
| `grok-bot` | `usagePercent` from `get-sand-usage-status` | `'Grok Bot'` (a bare string is valid `LocalizedText`; the product name is not translated) |

`resetsAt` for `plan` / `auto` / `api` / `on-demand` is `billingCycleEnd` (ISO-8601 string -> epoch ms via `Date.parse`). `grok-bot` uses `nextResetTimestampUtc`.

`plan` (the snapshot-level subscription tier, not the item) comes from `membershipType`, formatted as `Cursor <Name>` with CodexBar's mapping (`enterprise`->Enterprise, `express`->Start, `free`->Free, `free_trial`->Pro Trial, `hobby`->Hobby, `pro`/`pro_student`->Pro, `pro_plus`->Pro+, `team`->Team, `ultra`->Ultra, anything else verbatim). It must be trimmed: `LocalizedTextSchema` rejects untrimmed strings, and an untrimmed tier would fail validation of the whole otherwise-valid snapshot.

### Percent conversion

Cursor's `*PercentUsed` fields are **already in percentage units even when fractional** — `0.36` means 0.36%, not 36% (`CursorStatusProbe.swift:1628`). Getting this wrong silently mis-scales the ring by 100x.

```
remainingRatio = 1 - clamp(usedPercent, 0, 100) / 100
```

### Count conversion and zero / missing limits

For the cents-denominated blocks (`plan.used/limit`, `overall.used/limit`, `teamUsage.pooled.used/limit`, `onDemand.used/limit`):

```
limit missing, non-finite, or <= 0  ->  no ratio (that source is skipped)
otherwise                            ->  remainingRatio = 1 - clamp(used / limit, 0, 1)
```

A zero or absent limit never produces `0` or `1`. It produces *nothing*, and the next fallback rung is tried. CodexBar's `UsagePercent(used:limit:)` has `precondition(limit > 0)` for the same reason.

**An item with no resolvable ratio is omitted entirely.** An item carrying only `resetsAt` renders an empty bar, which reads as "0% left" — worse than not showing the lane. If *no* item resolves, `read` throws so the card shows an error.

### `plan` item fallback ladder

Ported from `CursorStatusProbe.swift:1645-1665`, in order, first hit wins:

1. `individualUsage.plan.totalPercentUsed`
2. mean of `autoPercentUsed` and `apiPercentUsed` when both are present
3. `apiPercentUsed` alone
4. `autoPercentUsed` alone
5. `individualUsage.plan.used / .limit`
6. `individualUsage.overall.used / .limit` (Enterprise / Team personal cap)
7. `teamUsage.pooled.used / .limit` (shared pool, last resort)

Rungs 6 and 7 are why the ladder is kept in full rather than trimmed: Enterprise and Team accounts get no `plan` block at all, and without them their ring is empty. Averaging *remaining* ratios is arithmetically identical to averaging *used* percents and inverting, so rung 2 needs no special handling.

### On-demand spend

`OAuthQuotaItem` has exactly four fields and `validateOAuthQuotaSnapshot`'s `ITEM_KEYS` rejects any other key. **There is no way to report a currency amount, and none is attempted** — no `$12.40 of $50`, no `providerCost` equivalent, no team-vs-personal split.

What *is* reportable is the dimensionless ratio: when `individualUsage.onDemand.limit` is a positive number, `used / limit` is a real budget-consumption fraction that behaves exactly like any other quota bar, and hitting it stops requests. **Decision: emit the `on-demand` item only when that limit is positive.** Accounts with no cap (unlimited or unset) get no item, which is correct — an uncapped budget has no ratio. `teamUsage.onDemand` is not used: CodexBar's personal-cap-wins / team-pool-fallback precedence exists to pick a *dollar figure* to display, and we display none.

## Failure semantics

| Condition | Behavior |
| --- | --- |
| Credential refresh fails | Propagate. `CredentialRefreshError` already carries retryability. |
| `usage-summary` returns 401 / 403 | Throw `Cursor rejected the session cookie; sign in to Cursor again`. This is the wrong-`sub` / expired-session signature and must be legible. |
| `usage-summary` returns any other non-2xx | Throw with the status. |
| `usage-summary` body is not a plain object | Throw. |
| No item resolves a ratio | Throw. An empty `items` array is a valid snapshot for the validator but a blank ring for the user. |
| `get-sand-usage-status` fails, times out, is malformed, or reports no Bot allowance | Return `undefined`. The monthly bars stay intact. CodexBar states this explicitly, and it is the same rule the ChatGPT reader applies to its reset-credit inventory. |
| `context.signal` aborts | `throwIfAborted()` after the concurrent reads, matching the ChatGPT reader. |

The Grok read gets **its own 4s budget** via `AbortSignal.any([context.signal, AbortSignal.timeout(4_000)])`, so a stalled enrichment endpoint cannot hold the dashboard refresh open behind the primary read. Its entire body is inside one `try / catch` that returns `undefined`.

`hasNonZeroIncludedLimit !== true` is treated as "no allowance", not as an error — accounts without a Grok Bot allowance are the common case.

## File layout

`packages/plugins/cursor/src/quota/`, following the directory-grouping rule and the `openai-chatgpt/src/quota/` precedent. Split by responsibility, planned up front because the reader spans two endpoints with different failure contracts:

```
quota/
├── index.ts     exports only: readCursorQuota
├── quota.ts     orchestration: refresh, cookie, concurrent reads, assemble snapshot (~50 lines)
├── cookie.ts    cursorUserId + cursorSessionCookie (~30 lines)
├── summary.ts   usage-summary fetch, wire-value parse helpers, item mapping (~160 lines)
├── sand.ts      Grok Bot best-effort read (~40 lines)
├── cookie.test.ts
├── summary.test.ts
└── quota.test.ts
```

`sand.ts` imports the numeric parse helpers (`remainingFromPercent`, `isoTimestamp`) from `./summary`. Both files parse the same flavor of cursor.com wire values, so those helpers are Cursor wire parsing rather than generic utilities, and a separate `parse.ts` would be a file with no responsibility of its own. Sibling imports inside the `quota/` directory are fine; nothing outside it imports anything but `quota/index.ts`.

No file approaches the 400-line review threshold.

`isPlainObject` from `es-toolkit/predicate` guards every wire payload, and `clamp` from `es-toolkit/math` does the range clamping. There is no hand-written object-shape or clamp helper and no new dependency; `es-toolkit` is already declared as `"catalog:"` in the plugin's `package.json`.

### No `dedupeItemIds`

The three existing readers carry a `dedupeItemIds` helper because their item ids are slugified from wire strings and can collide. Cursor's five ids are compile-time constants (`plan`, `auto`, `api`, `on-demand`, `grok-bot`), each emitted at most once. Duplicate ids are unreachable, so the helper would be dead code. Not ported.

## Wiring

`packages/plugins/cursor/src/plugin/plugin.ts`: one property on the adapter, mirroring `openai-chatgpt/src/plugin.ts:139`.

```ts
quota: { read: (context) => readCursorQuota(context, dependencies) },
```

`dependencies` is the existing `CursorRuntimeDependencies` the factory already threads through; it extends `CursorOAuthDependencies`, so the injected `fetch` / `now` used by the plugin's other tests work here too. Fetcher resolution inside the reader is `dependencies.fetch ?? context.fetch ?? globalThis.fetch`.

`packages/plugins/cursor/src/index.ts` gains `export * from './quota/index';`.

**Nothing in `packages/server` or `packages/dashboard` changes.** `hasQuota` derives from `adapter.quota !== undefined` and the ring is already implemented.

## Testing

Colocated, behavior-level, no restating of literals:

- **Cookie header is exact.** `sub: 'auth0|user_01ABC'` produces `WorkosCursorSessionToken=user_01ABC%3A%3A<accessToken>` on both requests. A wrong separator or a wrong `sub` split is a silent 401 with no other symptom, so this assertion is the highest-value test in the change.
- Trailing-`|` and no-`|` subjects both resolve; a `sub` whose last segment has characters outside `[A-Za-z0-9._-]` throws locally.
- A credential with **no** `subject` still works when the access token carries `sub` (the pre-`subject` stored-credential case).
- An expired credential is refreshed before use and the **refreshed** token appears in the cookie.
- Percent scaling: `autoPercentUsed: 0.36` yields `remainingRatio` 0.9964, not 0.9964e-2 and not 0.64.
- Fallback ladder: `totalPercentUsed` absent falls to the auto/api mean; a payload with only `individualUsage.overall` still produces a `plan` item.
- A zero or missing limit produces no item rather than a full or empty bar.
- Grok Bot: present with `hasNonZeroIncludedLimit: true`; absent when the flag is false; **a failing or timing-out sand endpoint leaves the monthly items unchanged**.
- 401 from `usage-summary` throws the sign-in-again message.
- A `usage-summary` payload with no usable numbers throws.
- The produced snapshot satisfies what `validateOAuthQuotaSnapshot` enforces: `toEqual` on the whole object catches unknown keys, `resetsAt` values are safe integers, ratios are inside `0..1`, `plan` is trimmed, and item ids are unique. The validator itself lives in `@aio-proxy/core`, which the plugin does not and should not depend on, so the assertions are made against the snapshot directly rather than by importing it.

## Changeset

Targets `@aio-proxy/plugin-cursor` and `aio-proxy` at `minor`. A changeset naming only the internal plugin package would produce an empty `aio-proxy` CHANGELOG entry, `scripts/release.ts` would skip the GitHub Release, and the note would vanish.
