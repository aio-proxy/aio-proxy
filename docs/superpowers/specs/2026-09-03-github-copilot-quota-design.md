# GitHub Copilot OAuth quota reporting

Date: 2026-09-03

## Problem

`@aio-proxy/plugin-github-copilot` registers an `OAuthAdapter` with no `quota` capability. The server sets
`DashboardProviderSummary.hasQuota` from `adapter.quota !== undefined`
(`packages/server/src/plugin-account.ts:119`), so a Copilot Provider card renders no quota ring at all. A user
with a metered Copilot plan has no way to see how many premium requests are left without leaving the dashboard.

GitHub exposes the numbers on `copilot_internal/user`, the same internal namespace this plugin already calls for
`copilot_internal/v2/token`. Nothing else is needed to light up the UI: implementing `quota.read` flips
`hasQuota` and the existing ring, dialog, and refresh plumbing take over.

## Goals

- `adapter.quota.read` returns an `OAuthQuotaSnapshot` that `validateOAuthQuotaSnapshot` accepts unchanged.
- Every metered window GitHub reports becomes one item; the plan label comes from `copilot_plan`.
- An account with no metered window (unlimited entitlement, token-based billing) is a **successful** read with
  zero items, not a failed one.
- One malformed entry cannot discard its valid siblings.
- Enterprise deployments read through the base this plugin already uses for its other GitHub REST calls.

## Non-goals

- **No `quota.reset`.** GitHub has no endpoint that redeems or resets a Copilot allowance. `reset` stays
  undefined; the dashboard only shows a reset control when the capability exists.
- **No budget extras.** CodexBar's "Budget extras" bars scrape `github.com/settings/billing/budgets` with
  imported browser cookies plus a nonce read out of the preceding HTML page. A server-side proxy has no browser
  cookie jar and no logged-in github.com web session, so that data is unreachable here by construction. This is
  settled; do not re-litigate it when someone notices CodexBar shows more bars than we do.
- No change to the login flow, the credential shape, the catalog, or the runtime.
- No new caching. The server already owns the quota read cooldown and the stale-snapshot fallback.

## Prior art

CodexBar is the only prior art. `.reference/CodexBar/Sources/CodexBarCore/Providers/Copilot/CopilotUsageFetcher.swift`
and `.reference/CodexBar/Sources/CodexBarCore/CopilotUsageModels.swift` are the authority on field spellings; the
summary in `.reference/CodexBar/docs/copilot.md` is a level of detail behind its own code (see the
`quota_reset_date` note below).

The CLI-Proxy-API Management Center (`https://github.com/router-for-me/Cli-Proxy-API-Management-Center`) is the
closest comparable server-side quota UI, and it does **not** support Copilot: its quota page covers
claude / antigravity / codex / kimi / xAI-Grok only. There is no second implementation to cross-check against.

## Upstream protocol

`GET <apiBase>/copilot_internal/user`.

Headers, from `CopilotUsageFetcher.addCommonHeaders` plus its `Authorization` line:

| Header | Value |
| --- | --- |
| `authorization` | `token <githubToken>` |
| `accept` | `application/json` |
| `Editor-Version` | `vscode/1.107.0` |
| `Editor-Plugin-Version` | `copilot-chat/0.35.0` |
| `User-Agent` | `GitHubCopilotChat/0.35.0` |
| `X-Github-Api-Version` | `2025-04-01` |

Two deliberate divergences from CodexBar:

- **Auth scheme is `token`, not `Bearer`.** This plugin's existing `authHeaders` sends `Bearer <githubToken>` to
  the sibling `copilot_internal/v2/token` and that works, so either scheme probably works here too — but
  `token` is the only form observed working against `copilot_internal/user`, and GitHub REST accepts `token`
  everywhere it accepts `Bearer`. Follow the evidence.
- **Editor version strings come from this repo, not from CodexBar.** `github-api/http.ts` already pins
  `vscode/1.107.0` / `copilot-chat/0.35.0` / `GitHubCopilotChat/0.35.0` in `copilotHeaders`, and
  `runtime/host-fetch.test.ts` asserts them. CodexBar's `1.96.2` / `0.26.7` are a year older. One plugin, one
  editor identity: those three strings become module constants in `http.ts` and both header builders read them.
  `X-Github-Api-Version` is new and has no existing constant.

### Response shape

```json
{
  "copilot_plan": "copilot_business",
  "quota_reset_date": "2026-10-01",
  "token_based_billing": false,
  "quota_snapshots": {
    "premium_interactions": { "entitlement": 300, "remaining": 210, "percent_remaining": 70, "unlimited": false },
    "chat": { "entitlement": 100, "remaining": 5, "percent_remaining": 5 }
  },
  "monthly_quotas": { "chat": 50, "completions": 2000 },
  "limited_user_quotas": { "chat": 20, "completions": 500 }
}
```

`CopilotUsageModels.swift` decodes `entitlement`, `remaining`, `credits_used`, and `percent_remaining` as
number-or-string, and `unlimited` as a bool. There is no `overage` field: CodexBar derives "over quota" from
`usedPercent > 100`, i.e. a negative `percent_remaining`.

## Decisions

### Enterprise API base: reuse `githubApiBase()`

CodexBar computes `api.<enterpriseHost>`. Our `github-api/urls.ts` computes `<enterpriseURL>/api/v3`. **We use
`githubApiBase(credential.enterpriseURL)`** — that is the base this plugin's own `credential.ts` already sends
`copilot_internal/v2/token` to, so the sibling path in the same namespace must not invent a second convention;
`/api/v3` is also GHES's documented REST root, whereas `api.<host>` is a github.com DNS convention CodexBar
inherited from its device-flow host handling.

The enterprise host comes from **the credential**, not from `context.options`. The credential's `enterpriseURL`
is the host the stored token was actually minted against; account options can be edited after login.

If a GHES host does not serve `copilot_internal/user`, the call 404s, `fetchJson` throws, and the server turns
that into `QUOTA_READ_FAILED`. The card shows the dashed unavailable ring, which is still a button that reopens
and retries. `hasQuota` is a static property of the adapter, so the ring appears for every Copilot Provider
including hosts that can never answer — that is existing framework behavior and not worth special-casing.

### `remainingRatio` without `resetsAt` is fine

Verified against the dashboard:

- `packages/dashboard/src/modules/providers/lib/quota-view/quota-view.ts` — `applicableQuotaItems` filters on
  `remainingRatio !== undefined` and nothing else; `tightestQuotaItem` reads only `remainingRatio`.
- `.../components/provider-quota-ring/provider-quota-item.tsx` — the "resets at" caption is rendered only when
  `item.resetsAt !== undefined`; the progress bar, label, and percentage do not consult it.
- `.../provider-quota-ring.tsx` — the arc geometry and the centre number come from `remainingRatio` alone.

So an item with a ratio and no reset time renders a complete bar minus one caption line. No degradation.

The inverse is fatal to usefulness: an item with `resetsAt` but no `remainingRatio` is filtered out of the dialog
entirely and can never be the tightest window, so it is invisible. **Never emit an item without a ratio.**

### `quota_reset_date` is surfaced as `resetsAt`

CodexBar's doc says "Reset dates are not provided by the API." Its own code disagrees:
`CopilotUsageResponse` decodes a top-level `quota_reset_date`, `parseQuotaResetDate` accepts ISO-8601 with or
without fractional seconds or a bare `yyyy-MM-dd`, and `fetch()` applies the one value to both windows. We do the
same — it is a real monthly boundary and a caption costs nothing. What the API does not provide is a *per-window*
reset, which is why every item carries the same timestamp.

`Date.parse` handles all three spellings; a bare `yyyy-mm-dd` parses as UTC midnight. The result must be a safe
integer or the field is omitted, because the validator rejects non-safe-integer timestamps.

When `quota_reset_date` is absent the items simply have no `resetsAt`, and the ring and bars render as described
above.

### Items: every `quota_snapshots` key, curated labels for the known ones

CodexBar squeezes the payload into two UI slots (primary / secondary), which forces its
premium-vs-chat-vs-dynamic-key fallback ladder. Our sink is a list plus a "tightest window" ring, so the simpler
rule is strictly better: **iterate `quota_snapshots` and emit one item per usable entry.**

| Source | `id` | `displayName` |
| --- | --- | --- |
| `quota_snapshots.premium_interactions` | `premium_interactions` | `{ default: 'Premium requests', 'zh-Hans': '高级请求' }` |
| `quota_snapshots.chat` | `chat` | `{ default: 'Chat', 'zh-Hans': '聊天' }` |
| `quota_snapshots.completions` | `completions` | `{ default: 'Code completions', 'zh-Hans': '代码补全' }` |
| any other `quota_snapshots` key | the key verbatim | the key, title-cased on `[\s_-]+`, untranslated |

The id is the raw key. Object keys are unique, so no two items can collide and the plugin needs no
`dedupeItemIds` pass of the kind `openai-chatgpt` and `xai-grok` carry. Keys that are blank after trimming are
dropped. The curated-label lookup is a `Map`, not an object literal, so a payload key of `constructor` or
`__proto__` cannot pull a function off `Object.prototype` and hand it to `LocalizedTextSchema`.

A key whose title-case is empty (pure separators) falls back to the trimmed key, which is guaranteed non-empty
and trimmed — `LocalizedTextSchema` rejects both empty and untrimmed strings.

Per-entry parsing is lossy: a `quota_snapshots` value that is not a plain object is skipped and its siblings
survive.

### Ratio derivation

Per entry, in order:

1. `unlimited === true` → drop (see below).
2. `entitlement === 0 && remaining === 0` (both decoded as numbers) → drop. This is GitHub's placeholder for
   token-based billing and Business seats; `CopilotUsageModels.swift` notes it is sometimes served with
   `percent_remaining: 100`, which would otherwise render as a confident "100% remaining" on a seat that has no
   metered allowance at all. The placeholder check therefore runs **before** `percent_remaining`.
3. `percent_remaining` present (number or numeric string) → `percent / 100`.
4. Otherwise `entitlement > 0` and `remaining` present → `remaining / entitlement`.
5. Otherwise drop.

Every result is clamped to `0..1`. An over-quota window reports a negative `percent_remaining` and clamps to `0`,
which is exactly what the dashboard means by empty.

### `unlimited` entitlements are omitted, not shown at 100%

An unlimited allowance has no denominator. Rendering it at 100% makes it indistinguishable from a full metered
window and, worse, would make the ring claim "100" for an account whose actual constraint is elsewhere. CodexBar
drops these too (`makeRateWindow` guards `!snapshot.unlimited`).

Consequence: an all-unlimited account produces `{ items: [], plan }`. **That is a success, not an error.** This
diverges from `openai-chatgpt`, which throws when it finds no windows. Throwing here would paint the dashed
"load failed" ring on a Provider whose read worked perfectly and whose honest answer is "nothing is metered". The
dashboard already handles it: the ring shows `—` with an empty arc and the dialog shows the
`dashboard.providers.quota.no_windows` message. Only a transport error, a non-2xx status, or a non-object body
throws.

### `monthly_quotas` / `limited_user_quotas` fallback

Free and older Copilot seats answer with counters instead of snapshots: `monthly_quotas` is the allowance and
`limited_user_quotas` is what remains, both keyed `chat` / `completions`. Without this fallback those accounts —
a real and large segment — see an empty ring forever. It is ~20 lines and reuses the same label table.

The fallback contributes only ids that `quota_snapshots` did not already produce. Emitting `chat` twice would
make `validateOAuthQuotaSnapshot` reject the whole snapshot on the duplicate-id rule, taking the valid windows
down with it.

### `copilot_plan` normalization

Trim, split on `[\s_-]+`, title-case each part, rejoin with spaces: `copilot_business` → `Copilot Business`,
`free` → `Free`. An absent, empty, or `unknown` value omits `plan` entirely rather than showing the literal
`Unknown` under the Provider name. Title-casing always yields a trimmed non-empty string or `''`, and `''` is
filtered — the validator's `LocalizedTextSchema` rejects untrimmed and empty strings, and a rejected `plan` fails
the entire otherwise-valid snapshot.

The plan is a plain `string`, not a locale map: it is an upstream enum with no authored translation.

Each of `openai-chatgpt`, `xai-grok`, and `kimi-code` carries its own small title-caser. Plugin packages depend
only on `@aio-proxy/plugin-sdk`, so a fourth local copy is the established shape, not a missed reuse.

### File placement: `src/github-api/`, not a new `src/quota/`

The reader goes in `packages/plugins/github-copilot/src/github-api/quota.ts` with
`src/github-api/quota.test.ts` beside it, exported from the existing `src/github-api/index.ts`.

`github-api/` is already this plugin's same-name grouping directory: `index.ts` is exports-only, and
`credential.ts` / `catalog.ts` / `login.ts` sit next to their colocated tests. The quota read is one
authenticated GitHub REST call that needs `githubApiBase()`, the editor header constants, and `fetchJson` — all
of which live there. A separate `src/quota/` would either re-derive the API base and the editor identity or
reach across into `github-api/` private modules; the CLAUDE.md grouping rule is satisfied by `github-api/`
itself.

The wire schema goes in `src/schema.ts` next to every other response schema in this plugin, and the HTTP call
goes through the existing `fetchJson` helper, which already produces the plugin's standard
`GitHub Copilot request failed (<status>)` error.

### Injection and traffic tagging

`readGitHubCopilotQuota(context, fetcher = context.fetch ?? globalThis.fetch)`, mirroring
`readOpenAIChatGPTQuota`. The request carries `aioProxy: { traffic: 'control' }` so `runtime/host-fetch.ts`
routes it as control-plane traffic and it never counts as model traffic.

The reader calls `context.credentials.read()` directly rather than `currentGitHubCopilotCredential`. It needs the
long-lived `githubToken`, not the short-lived `copilotToken`, so going through the refresh helper would fire an
extra `copilot_internal/v2/token` round trip on every quota poll for nothing.

## Testing

- Two snapshots plus `quota_reset_date` map to two items with ratios and one shared reset timestamp, and
  `copilot_plan` title-cases into `plan`.
- The request goes to `https://api.github.com/copilot_internal/user` with `authorization: token github-token`,
  the editor headers, `X-Github-Api-Version`, and `aioProxy: { traffic: 'control' }` — and is the **only**
  request, proving an expired `copilotToken` did not drag a refresh along.
- An enterprise credential reads `https://company.ghe.com/api/v3/copilot_internal/user`.
- A non-2xx status throws `GitHub Copilot request failed (401)`.
- An `unlimited` entry and a zero-entitlement placeholder both drop, and the result is `{ items: [], plan }` —
  a successful read, not a throw.
- A missing `percent_remaining` derives from `remaining / entitlement`; a negative one clamps to `0`.
- An unfamiliar key becomes a title-cased item, and a non-object sibling in the same `quota_snapshots` does not
  take it down.
- `monthly_quotas` / `limited_user_quotas` produce `chat` and `completions` items when `quota_snapshots` has
  nothing usable, and produce nothing for an id `quota_snapshots` already covered.
- The registered adapter answers `quota.read` end-to-end through `context.fetch`, and exposes no `quota.reset`.

## Release

The changeset targets `@aio-proxy/plugin-github-copilot` **and** `aio-proxy` at `minor`. A changeset naming only
the plugin would still bump `aio-proxy` through the `fixed` group, but with an empty CHANGELOG entry, so
`scripts/release.ts` would skip its GitHub Release and the note would vanish.
