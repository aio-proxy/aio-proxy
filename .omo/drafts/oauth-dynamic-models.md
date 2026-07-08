---
slug: oauth-dynamic-models
status: plan-written
intent: clear
pending-action: write .omo/plans/oauth-dynamic-models.md
approach: OAuth providers drop config `models`; runtime derives model exposure (auto self-alias routes) from the Auth-payload cached vendor model list; config `alias` remains as optional override; fix login writer, ChatGPT alias passthrough, and /v1/models listing in the same chain. TDD with bun:test.
---

# Draft: oauth-dynamic-models

## Components (topology ledger)

| id | outcome | status | evidence |
|---|---|---|---|
| C1 | types schema: `OAuthProviderSchema` drops `models`; api/ai-sdk keep it; alias validation naturally no-ops for oauth | active | packages/types/src/provider.ts:26-47,78-100 |
| C2 | oauth runtime: instances derive alias map = autoSelfAliases(payload.models) merged with config.alias; ChatGPT runtime passes alias through (Bug B); Copilot keeps transport dispatch from payload | active | packages/server/src/oauth-runtime.ts:25-76; packages/server/src/oauth-chatgpt-runtime.ts:31-66 |
| C3 | oauth package: login flow stores vendor model list in payload for both vendors (moves copilot model-sync out of CLI); CLI login writes config entry as just {kind, vendor} (Bug A) | active | packages/cli/src/provider-commands.ts:80-93,122,148; packages/oauth/src/openai-chatgpt/index.ts:90-99 |
| C4 | /v1/models lists alias keys + preserved ids only (spec-compliant, Bug C); oauth listing flows automatically from derived alias | active | packages/server/src/server.ts:109-126; docs/superpowers/specs/2026-07-05-model-alias-config-design.md:144 |
| C5 | repo example config aio-proxy.json migrated to new semantics (carpool gets self-alias; chatgpt stays {kind, vendor}) | active | aio-proxy.json:1-20 |

## Open assumptions (announced defaults)

| assumption | adopted default | rationale | reversible? |
|---|---|---|---|
| dynamic list source | login/refresh-time cached `payload.models` from Auth store (sync sqlite read), never live network fetch at startup/reload | keeps server-state router construction CPU-only (server-state.ts:147 comment); Copilot runtime already reads payload sync | yes |
| alias derivation location | provider materialization (oauth-runtime), NOT Router | spec:142 "keep route construction centralized in Router; route files should not learn alias rules" — Router keeps reading instance.alias | yes |
| config.alias vs auto self-alias collision | config.alias key wins over auto self-alias | user intent beats defaults | yes |
| config.alias targeting unknown vendor model | keep the alias (no parse/runtime rejection); upstream will fail naturally | list is dynamic; parse-time validation impossible; user may know newer models | yes |
| payload.models missing (stale login) | provider exposes only config.alias (possibly zero routes); ensureAvailable error hints re-login | graceful degradation; re-login syncs | yes |
| models fetch failure during login | best-effort: store payload without models, warn on stderr, login still succeeds | auth success should not be discarded because a listing call failed | yes |
| old configs still carrying oauth `models` | zod object strips unknown keys silently — no parse error, key ignored | z.object default strip behavior; backward compatible | yes |
| api/ai-sdk `models` semantics | unchanged (validation set + nothing else after Bug C fix removes raw listing) | user question scoped to oauth; PR #7 alias-only philosophy stands for these kinds | yes |

## Findings (cited - path:lines)

- Config `models`+`alias` shared by all provider kinds: packages/types/src/provider.ts:26-32; OAuth inherits at :43-47.
- Router routes ONLY via alias; models produce zero routes: packages/core/src/index.ts:218-223; spec line 84.
- OAuth model list exists in 3 places: vendor method `models(payload)` (copilot fetches upstream /models github-copilot/index.ts:200-221; chatgpt static list openai-chatgpt/index.ts:21-26,86-88), Auth payload cache, config `models`.
- Server runtime NEVER calls `OAuthProvider.models()`; only CLI login does (provider-commands.ts:122,148) — confirmed by explore agent + direct read.
- Copilot runtime reads payload.models for transport dispatch: oauth-runtime.ts:31-32; spreads config.models/alias :64-65.
- ChatGPT runtime spreads config.models but NOT alias (Bug B): oauth-chatgpt-runtime.ts:52-57; payload.models REQUIRED by parseChatGPTPayload :106-126.
- CLI login writes `models` ids into config but NO self-alias (Bug A): provider-commands.ts:86-90; spec:146 required self-alias sync.
- /v1/models lists raw un-aliased models (Bug C, commit 4dd64d3 drifted from spec:144): server.ts:109-126.
- Current aio-proxy.json registers ZERO routes under HEAD semantics (carpool models-only; chatgpt no models/alias): aio-proxy.json:1-20.
- Auth store reads are sync bun:sqlite: packages/oauth/src/store.ts:18-40.
- OAuthProviderInstance already has optional alias field: packages/server/src/runtime.ts:11.

## Decisions (with rationale)

1. **Fork 1 = dynamic follow vendor (user-picked)**: OAuth config drops `models`; runtime auto-exposes payload.models as self-alias routes; config alias = optional rename/narrow/variants override. Partially diverges from PR #7 alias-only philosophy FOR OAUTH KIND ONLY, deliberately, per user decision.
2. **Fork 2 = full chain fix (user-picked)**: Bug A (login writer), Bug B (chatgpt alias passthrough), Bug C (/v1/models spec compliance) in the same plan.
3. **Fork 3 = TDD (user-picked)**: failing tests first per todo; bun:test, existing suites as patterns (router.test.ts, oauth-provider-runtime.test.ts, provider-commands.test.ts, server.test.ts).
4. Model sync moves INTO oauth package login flow so any login surface stays consistent; CLI thins down.
5. **Collision guard (self-found)**: auto self-alias for model M must be OMITTED when config.alias has key==M OR any config alias targets M with preserve:true — otherwise modelRoutes emits duplicate `provider/M` routes → RouterModelCollisionError at startup (mirrors normalizeAliasPreserve, commit 2e5b3fb). Mandatory test case.
6. **ChatGPT list source = code, not payload (self-found)**: OPENAI_CHATGPT_MODELS static list in code is the vendor truth for chatgpt (payload written at old login goes stale when code updates the list); derivation uses the current static list; payload.models stays required for schema compat. Copilot truth = payload (login-time snapshot, re-login to refresh).
7. **Reload mechanism (verified)**: CLI login always rewrites the config file → server config watcher (fs.watch, config-watcher.ts) fires → materializeProviders re-reads Auth payload → routes refresh on a running server. No new mechanism needed; document it.
8. **Schema artifact (verified)**: config.schema.json auto-generated from ConfigSchema by rslib plugin (packages/types/rslib.config.ts:5-14) — regenerates on build, no manual JSON edit.

## Scope IN

- packages/types: OAuthProviderSchema drops models field (+ schema tests).
- packages/oauth: login stores models in payload (copilot fetch-during-login best-effort; chatgpt already does); type updates.
- packages/server: oauth-runtime derives alias from payload.models ∪ config.alias for BOTH vendors; chatgpt runtime alias passthrough; exposedModels spec-compliant.
- packages/cli: provider login writes {kind, vendor} only; drops Auth.set duplication if oauth package now owns it.
- aio-proxy.json example migration; config.schema.json regeneration if generated.
- AGENTS.md/docs note if they mention oauth models config.

## Scope OUT (Must NOT have)

- NO live vendor fetch at server startup/reload/router construction.
- NO new CLI command for model refresh (re-login is the sync path; future work).
- NO change to api/ai-sdk `models` config semantics (still validation-only).
- NO transport metadata leaking into public config shape (spec:146).
- NO weighted-routing changes; config order remains the weight (AGENTS.md).
- NO dashboard feature work beyond what listing fix touches.

## Open questions

(none — all forks resolved via question tool 2026-07-07)

## Approval gate

status: plan-written (approved 2026-07-07; Metis folded: 12 findings — HIGH 1/2/3/4 as todo requirements, MED 5-9 as todo details, LOW 10 scoped out as future work, LOW 11/12 folded into T5/T6)
plan: .omo/plans/oauth-dynamic-models.md (8 todos, 3 waves + final; TDD)
delivery question pending: start work vs dual high-accuracy review first
