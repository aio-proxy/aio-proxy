# Google Antigravity OAuth quota reporting

Date: 2026-09-03

## Problem

`@aio-proxy/plugin-google-antigravity` has no `quota` capability. `prepareOAuthPluginAccount`
(`packages/server/src/plugin-account.ts:119`) sets `DashboardProviderSummary.hasQuota` from
`adapter.quota !== undefined`, so the Provider card renders no quota ring for Antigravity accounts.
Users cannot see how much of their five-hour or weekly Antigravity allowance is left without opening
the Antigravity desktop app.

Antigravity does expose the numbers over plain HTTP with a Bearer token
(`POST <base>/v1internal:retrieveUserQuotaSummary`), which is exactly the shape a server-side proxy
can consume.

## Goals

- `adapter.quota.read` returns a validated `OAuthQuotaSnapshot` for a signed-in Antigravity account.
- Items cover every bucket the upstream reports, grouped by model family, five-hour before weekly.
- The account's subscription tier appears as `OAuthQuotaSnapshot.plan` when the upstream tells us.
- Nothing else changes: no new dependency, no dashboard change, no server change.

## Non-goals

- **`quota.reset` is out of scope.** Antigravity has no redeem/reset endpoint — the reference
  Management Center exposes no such call and neither does the CLI. `OAuthQuotaCapability.reset`
  stays `undefined`.
- **`resetCredits` is out of scope.** There is no credit inventory in this payload.
- Do not port any local-app path from the CodexBar reference: SQLite reads, `agy` CLI probing, and
  `language_server` ports are unreachable from a server-side proxy.
- Do not touch model catalog discovery, refresh, or the runtime provider.

## Upstream protocol

Primary reference: the CLI-Proxy-API Management Center, which reads the same quota over plain HTTP
with a server-held OAuth token.

- `src/utils/quota/constants.ts` — `ANTIGRAVITY_QUOTA_URLS`, `ANTIGRAVITY_CODE_ASSIST_URL`,
  `ANTIGRAVITY_REQUEST_HEADERS`, `buildAntigravityUserAgent`
- `src/utils/quota/builders.ts` — `buildAntigravityQuotaGroups`
- `src/services/api/antigravitySubscription.ts` — `parseAntigravitySubscriptionSummary`
- `src/utils/quota/parsers.ts` — `normalizeQuotaFraction`
- `src/utils/quota/resetInstants.ts` — `resolveResetMs`

### Quota request

```
POST <base>/v1internal:retrieveUserQuotaSummary
Authorization: Bearer <access token>
Content-Type: application/json
User-Agent: antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)

{"project":"<projectId>"}
```

This is `retrieveUserQuotaSummary`, **not** the `retrieveUserQuota` the CodexBar macOS reference
calls. Only the Summary variant returns the grouped data the Antigravity Model Quota UI shows.

### Quota response

```jsonc
{
  "groups": [
    {
      "displayName": "Gemini Models",        // or display_name
      "description": "Models within this group: ...",
      "buckets": [
        {
          "window": "5h",                     // 5h | five-hour | five_hour | weekly | week
          "remainingFraction": 0.85,          // or remaining_fraction; 0..1, also "85%"
          "bucketId": "...",                  // or bucket_id
          "displayName": "5 hour limit",      // or display_name
          "resetTime": "2026-09-03T20:00:00Z",// or reset_time
          "description": "..."
        }
      ]
    }
  ]
}
```

Both camelCase and snake_case spellings appear in the wild; read both, camelCase first.

### Plan request

```
POST <base>/v1internal:loadCodeAssist
{"metadata":{"ideType":"ANTIGRAVITY"}}
```

Read `paidTier` (falling back to `currentTier`); the effective tier is `paidTier` when it carries an
`id`, otherwise `currentTier`. Snake_case `paid_tier` / `current_tier` also appear.

| `id` | Label |
| --- | --- |
| `free-tier` | `{ default: 'Free', 'zh-Hans': '免费版' }` |
| `g1-pro-tier` | `{ default: 'Pro', 'zh-Hans': '专业版' }` |
| `g1-ultra-tier` | `{ default: 'Ultra', 'zh-Hans': '旗舰版' }` |
| `g1-ultra-lite-tier` | `{ default: 'Ultra Lite', 'zh-Hans': '轻量旗舰版' }` |

The tier's own `name` wins when present — it is the string Google chose to show the user, and it
stays correct when Google adds a tier id we have not mapped. An unmapped id with no `name` is used
verbatim. A tier with neither `id` nor `name` yields no `plan`.

## Decisions

### Base URLs

Quota uses the plugin's standard non-onboarding base list: `https://daily-cloudcode-pa.googleapis.com`,
then `https://daily-cloudcode-pa.sandbox.googleapis.com`. Daily is where a live Antigravity client
actually gets answered. `retrieveUserQuotaSummary` is a `/v1internal:` method on the same host set as
inference and discovery, so it has no reason to want a different list than its siblings.

`'quota'` joins the `AntigravityOperation` union in
`packages/plugins/google-antigravity/src/runtime/endpoints.ts` but gets no case of its own: it falls
through to the shared defaults, which also means it inherits the `lastGood` reordering for free. The existing
account-level `baseURL` override keeps its established meaning: **a configured `baseURL` replaces
the whole list with `[baseURL]`**, exactly as it already does for discovery and inference. One rule
for every Antigravity call, and a user pointing at a self-hosted relay does not get surprise traffic
to Google.

`loadCodeAssist` uses `endpoints[0]` — the first quota base — with **no** failover. It is enrichment;
one attempt is enough, and the override still applies.

Two constants are added to `packages/plugins/google-antigravity/src/oauth/constants.ts`:
`ANTIGRAVITY_SANDBOX` and `ANTIGRAVITY_CLI_USER_AGENT`.

### User-Agent

The quota and plan calls send `antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)`,
not the plugin's existing `antigravityUserAgent()` (`antigravity/hub/<version> <platform>/<arch>`).
The `v1internal:` quota surface is gated on the CLI client string; the hub UA is what the *desktop
updater* sends and is not interchangeable. It is a fixed literal — the hub-version cache exists to
track desktop releases and has nothing to say about the CLI version.

### Item ids

`id = <groupSlug>-<bucketSlug>`.

- `groupSlug` = slugified group `displayName`, falling back to `group-<1-based index>`.
- `bucketSlug` = the canonical window slug (`5h` for `5h`/`five-hour`/`five_hour`, `weekly` for
  `weekly`/`week`), else the slugified `bucketId`, else `bucket-<1-based index>`.

Stable across refreshes because both halves come from labels the upstream repeats verbatim on every
call, and never from array position when a name is available. Unique across groups because of the
group prefix: `gemini-models-weekly` and `claude-and-gpt-models-weekly` do not collide.

`dedupeItemIds` (mirroring `packages/plugins/openai-chatgpt/src/quota/quota.ts`) still runs over the
flattened result. It is the guard for the one case the derivation cannot rule out — two buckets in
the *same* group naming the same window, or two groups whose display names slugify identically. The
core validator (`validateOAuthQuotaSnapshot`) rejects a duplicate id outright, which would kill the
whole card, so a suffixed `-2` is strictly better than a throw.

### Display names

`displayName` is a `LocalizedText` map with a `zh-Hans` translation for the two known windows,
built with the same `prefixed(group, label)` composition
`packages/plugins/openai-chatgpt/src/quota/quota.ts` uses:

| Window | `displayName` |
| --- | --- |
| `5h` / `five-hour` / `five_hour` | `{ default: '<Group> · 5-hour limit', 'zh-Hans': '<Group> · 5 小时额度' }` |
| `weekly` / `week` | `{ default: '<Group> · Weekly limit', 'zh-Hans': '<Group> · 周额度' }` |
| anything else | `{ default: '<Group> · <upstream label>' }` — no translation invented |

The group name stays in its upstream English form inside both locales; it is a product name
(`Gemini Models`, `Claude and GPT models`), not prose. When a group has no display name at all, the
bucket label is used unprefixed.

### Item ordering

Groups in payload order. Within a group: five-hour, then weekly, then any unrecognized window in
payload order (`Array.prototype.sort` is stable). No alphabetical tiebreak — payload order is the
order Antigravity's own UI shows, and re-sorting by label would shuffle rows between refreshes when
a display name changes.

### Buckets that are dropped

A bucket with no parseable `remainingFraction` is dropped. The ring is the entire point of the item;
a row with only a reset time renders as an empty ring and reads as "you have zero left", which is
worse than not showing the row. This matches `buildAntigravityQuotaGroups`, which returns `null` for
exactly this case. Non-object bucket entries and non-object groups are dropped individually — one
malformed sibling must not discard the rest.

### The all-100% payload

An `retrieveUserQuotaSummary` payload where every bucket reads `remainingFraction: 1` is **treated as
real quota** and reported as-is.

CodexBar's warning is about a different endpoint: it accepts an all-100% *`fetchAvailableModels`*
payload only after `retrieveUserQuota` echoes fractions, because `fetchAvailableModels` proves model
*availability* and has no quota semantics at all. We never call `fetchAvailableModels` for quota. A
grouped `retrieveUserQuotaSummary` response carries per-window buckets with reset timestamps — there
is nothing in it to distinguish "placeholder" from a genuinely untouched account at the start of a
window, and a fresh or lightly used account is the common case. Suppressing it would blank the card
for exactly the users whose quota is healthy.

### Failure semantics

| Failure | Behavior |
| --- | --- |
| credential refresh fails | throws (`currentGoogleCredential` propagates `CredentialRefreshError`) |
| one base: network error, non-2xx, non-object body, or zero usable buckets | remember it, try the next base |
| every base failed | throw the last remembered error — the card shows an error |
| `context.signal` aborted | throw immediately; never swallowed into the retry loop |
| `loadCodeAssist` anything | swallow, omit `plan` |

The plan read gets its **own** timeout (`PLAN_TIMEOUT_MS = 4_000`) layered onto `context.signal` with
`AbortSignal.any`, the same way the ChatGPT reader fences its reset-credits read. Enrichment must
never hold up the number the user actually asked for. It is started before the base-URL loop so it
overlaps the quota request, and it resolves rather than rejects, so an early throw from the quota
loop cannot leave an unhandled rejection.

`QUOTA_WALK_BUDGET_MS = 12_000` is divided by the live base count, so the whole walk costs at most
12s however long the list is — under the server's 15s read abort, with the remainder left for the
untimed credential refresh ahead of it. Dividing at call time rather than hardcoding a per-attempt
value is what keeps a single-base `baseURL` account from being cut short by a divisor sized for the
default list.

The access token is refreshed through `currentGoogleCredential` before the first request, exactly as
`catalog/discover.ts` does. An account whose token expired between dashboard loads shows quota, not
a 401.

## Validator compliance

Every snapshot must survive `validateOAuthQuotaSnapshot`
(`packages/core/src/plugins/quota.ts`). The reader therefore:

- emits plain object literals only — no proxies, no class instances, no `Object.create(null)`
- emits only `id`, `displayName`, `remainingRatio`, `resetsAt` on items and only `items` / `plan` on
  the snapshot; optional fields are spread in conditionally, never set to `undefined`
- clamps `remainingRatio` into `0..1` (`Math.min(1, Math.max(0, value))`) — a `remaining_fraction`
  of `1.02` would otherwise be rejected outright
- returns `resetsAt` only when `Number.isSafeInteger` holds
- keeps every `LocalizedText` string trimmed and non-empty (`LocalizedTextSchema` rejects both an
  empty string and one with surrounding whitespace)
- guarantees unique item ids via `dedupeItemIds`

## Files

- Create `packages/plugins/google-antigravity/src/quota/index.ts` — exports only.
- Create `packages/plugins/google-antigravity/src/quota/quota.ts` — the reader.
- Create `packages/plugins/google-antigravity/src/quota/quota.test.ts` — colocated test.
- Modify `packages/plugins/google-antigravity/src/oauth/constants.ts` — two constants.
- Modify `packages/plugins/google-antigravity/src/runtime/endpoints.ts` — `'quota'` operation.
- Modify `packages/plugins/google-antigravity/src/plugin.ts` — `quota: { read: ... }` on the adapter.
- Create `.changeset/google-antigravity-quota.md`.

`quota.ts` lands around 200 lines, well inside the 400-line review threshold, so no further split.

## Testing

- Grouped payload maps to five-hour-then-weekly items with the localized window labels, correct
  group-prefixed ids, clamped ratios, and parsed reset instants; malformed sibling buckets and a
  fraction-less bucket are dropped without taking their neighbors.
- A `"55%"` string fraction is read as `0.55`.
- An all-`1` payload still produces items with `remainingRatio: 1` (the documented decision).
- `plan` prefers the paid tier's `name`; falls back to the current tier and to the built-in
  `free-tier` label; is absent when `loadCodeAssist` 404s, and the items survive that.
- A 404 on the first base falls through to the sandbox base, in order.
- Every base failing throws.
- A payload with no usable bucket throws.
- A configured account `baseURL` is the only host contacted.
- `adapter.quota` is defined on the registered adapter (this is what lights up the dashboard ring).

## Changeset

Targets both `@aio-proxy/plugin-google-antigravity` and `aio-proxy` at `minor`. A changeset naming
only the plugin would still bump `aio-proxy` through the `fixed` group but leave its CHANGELOG entry
empty, and `scripts/release.ts` would skip the GitHub Release — the note would silently vanish.
