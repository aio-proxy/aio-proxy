# oauth-dynamic-models - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**What you'll get:** OAuth 账号登录后即插即用：代理立刻暴露并路由该账号真实可用的模型，配置文件不再保存一份会过期的模型清单（别名配置仍可用于改名或收窄暴露）。同时修复三个断链：登录后零路由、ChatGPT 别名不生效、模型列表接口列出实际无法调用的模型。

**Why this approach:** 模型清单的真相在提供方（Copilot 在其服务端、ChatGPT 在客户端内置表），配置里的副本注定过期；改为运行时从登录缓存派生路由，既保持服务启动零网络请求，又让列表随重新登录自动刷新。

**What it will NOT do:** 不会在服务启动或热重载时实时请求上游；不新增模型刷新命令（重新登录即同步）；不改变 API/AI-SDK 提供方的配置语义。

**Effort:** Medium
**Risk:** Medium - 路由派生触及所有 OAuth 请求路径；以 TDD、碰撞守卫和降级警告压住。
**Decisions to sanity-check:** OAuth 默认自动暴露全部厂商模型（与其他 provider "必须显式 alias" 的哲学有意分叉）；模型列表接口恢复设计规范行为后，只配了 models 而没配 alias 的 API provider 将不再出现在列表中。

Your next move: 直接开始执行（$start-work），或先跑一轮高精度双重评审。Full execution detail follows below.

---

> TL;DR (machine): Medium effort/risk; 8 todos in 3 waves + final; oauth config drops `models`, runtime derives routes from vendor model lists (copilot=payload cache, chatgpt=static), fixes login-writer/chatgpt-alias//v1/models chain; TDD bun:test.

## Scope
### Must have
- `OAuthProviderSchema` no longer accepts/needs `models`; api & ai-sdk keep it. Legacy oauth configs carrying `models` parse fine (key stripped).
- OAuth runtime derives routable exposure from the vendor model list: Copilot = `payload.models` cached in Auth store at login (sync sqlite read); ChatGPT = in-code `OPENAI_CHATGPT_MODELS` static list. Derived alias = auto self-aliases MERGED with optional config `alias` (config key wins; collision-guard vs preserve).
- Copilot login stores the vendor model list (with transport) in the Auth payload (best-effort; login still succeeds on fetch failure).
- CLI `provider login` writes only `{kind, vendor}` into the config file (Bug A).
- ChatGPT runtime instance carries the derived alias map so its routes register (Bug B — full derivation, not bare config.alias passthrough).
- `/v1/models` lists alias keys + preserved ids only, per design spec line 144 (Bug C).
- Example `aio-proxy.json` migrated: carpool gets a self-alias; chatgpt oauth entry stays `{kind, vendor}`.
- TDD with bun:test throughout; every todo ships its tests.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- NO live vendor network fetch during server startup, config reload, or router construction (preserve the CPU-only swap invariant, `packages/server/src/server-state.ts:147`).
- NO new CLI command for model refresh (re-login is the sync path; future work).
- NO change to api/ai-sdk `models` config semantics (still alias-validation input; only the /v1/models raw listing is removed per spec).
- NO transport metadata in the public config shape (spec line 146).
- NO Router (`packages/core/src/index.ts`) changes — derivation lives at provider materialization (spec line 142).
- NO weighted-routing work; config order remains the weight (AGENTS.md).
- NO fix for the pre-existing config-watcher rename-event over-trigger (`config-watcher.ts:12-14`) — recorded as future work.
- NO dashboard feature work.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: TDD (failing test first per todo) + bun:test; suites: `packages/types/_test/schemas.test.ts`, `packages/oauth/_test/*`, `packages/server/_test/oauth-provider-runtime.test.ts`, `packages/server/_test/oauth-chatgpt-runtime.test.ts`, `packages/server/_test/server.test.ts`, `packages/cli/_test/provider-commands.test.ts`, plus a new derive-helper unit suite.
- Gates per todo: `bun test <package>` green; repo-wide `bun run test` (turbo) + `bunx biome check .` + `bun run build` (regenerates `packages/types/dist/config.schema.json`) in the final wave.
- Evidence: .omo/evidence/task-<N>-oauth-dynamic-models.txt

## Execution strategy
### Parallel execution waves
> Wave sizes are dependency-driven: W1 seeds two independent packages, W2 is the runtime core, W3 is externally visible behavior. Under-3 waves are deliberate (hard dependency chain), not under-splitting.
- **Wave 1 (parallel, independent packages):** T1 (types schema sink), T2 (oauth pkg payload model sync)
- **Wave 2 (after W1):** T3 (derive helper), then T4 (copilot runtime) + T5 (chatgpt runtime) + T6 (CLI writer) — T4/T5 depend on T3; T6 only on T2
- **Wave 3 (after W2):** T7 (/v1/models listing), T8 (example config + docs sweep)
- **Final wave:** F1-F4

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| T1 | - | T3, T4, T5, T6, T7, T8 | T2 |
| T2 | - | T4, T6 | T1 |
| T3 | T1 | T4, T5 | T6 |
| T4 | T1, T2, T3 | T7 | T5, T6 |
| T5 | T1, T3 | T7 | T4, T6 |
| T6 | T1, T2 | T8 | T3, T4, T5 |
| T7 | T4, T5 | F* | T8 |
| T8 | T1, T6 | F* | T7 |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. packages/types: sink `models` out of SharedProviderSchema so OAuth loses it
  What to do: Move the `models` field OUT of `SharedProviderSchema` (packages/types/src/provider.ts:26-32) and declare it explicitly (same zod def, extract a shared `const` if clean) on `ApiProviderSchema` (:34-41) and `AiSdkProviderSchema` (:49-64) ONLY. `OAuthProviderSchema` (:43-47) keeps `alias` but has NO `models` — zod object strip behavior then silently drops the key from legacy oauth configs (NOTE: strip only works once the field is UNDEFINED on the schema; that is exactly this sink — do not rely on strip while the field is still declared). Adjust `ProviderAliasTargets` (:70) to an explicit `{ readonly models?: readonly string[]; readonly alias?: ... }` shape so `validateAliasTargets` (:78-100) compiles against the union where oauth lacks `models` (it already early-returns when `models === undefined`, which becomes the permanent oauth path — parse-time alias-target validation for oauth intentionally moves to runtime warning, see T3). Update `packages/types/src/config.ts` only if types ripple. TDD: first write failing tests in packages/types/_test/schemas.test.ts — (a) oauth provider input WITH a `models` key parses successfully and the output has NO `models` property; (b) oauth provider with `alias` but no `models` passes validation (no "not listed in models" issue); (c) api and ai-sdk providers still validate alias targets against `models` (existing tests keep passing, e.g. :256 legacy-shape rejection).
  Must NOT do: no changes to alias schema/normalizeAliasPreserve; no Router changes; do not remove `models` from api/ai-sdk.
  Parallelization: Wave 1 | Blocked by: - | Blocks: T3,T4,T5,T6,T7,T8
  References: packages/types/src/provider.ts:26-133; packages/types/src/common.ts:1-29; packages/types/src/config.ts:15-34; packages/types/_test/schemas.test.ts:18,50,217,256-287; design spec docs/superpowers/specs/2026-07-05-model-alias-config-design.md:88-106; schema artifact auto-regen: packages/types/rslib.config.ts:5-14 (no manual JSON edits)
  Acceptance criteria: `bun test _test/schemas.test.ts` green in packages/types (workdir packages/types, `bun run test`); new tests (a)(b)(c) present and passing; `rtk rg -n "models" packages/types/src/provider.ts` shows models only on Api/AiSdk schemas.
  QA scenarios: happy = run packages/types tests, capture output; failure = feed oauth config with `models: [""]` (empty string in stripped key) and assert it STILL parses (key stripped before element validation) — document actual behavior; Evidence .omo/evidence/task-1-oauth-dynamic-models.txt
  Commit: Y | feat(types): scope models config to api and ai-sdk providers

- [x] 2. packages/oauth: Copilot login stores the vendor model list in the Auth payload
  What to do: Add `readonly models?: readonly GitHubCopilotModel[]` to `GitHubCopilotPayload` (find the type — packages/oauth/src/github-copilot/, referenced at index.ts:96-104; Metis: the type currently has NO models field, adding it is REQUIRED or the write has no landing spot). In `GitHubCopilotOAuthProvider.login()` (index.ts:72-113), after computing `baseUrl` and `copilot.access` (:93-94), best-effort call the existing `fetchModels(baseUrl, copilot.access, callbacks.signal)` (:200-213) — enterprise path automatically uses the enterprise-aware baseUrl already computed at :94 — and include `models` in the payload passed to `this.store(...)` (:104). On fetch failure: catch, `console.error`/`callbacks.onProgress` warn "model list sync failed — /v1/models exposure requires re-login", and store the payload WITHOUT models; login still returns authenticated. Keep the synchronous ordering contract: `store()` (bun:sqlite sync, packages/oauth/src/store.ts:42-68) completes before login returns — add a one-line comment that CLI config writes MUST happen after login resolves (reload reads this payload). ChatGPT side: `finishLogin` already stores `models` (openai-chatgpt/index.ts:90-99) — verify, do not change. Export `OPENAI_CHATGPT_MODELS` (openai-chatgpt/index.ts:21-26) from the oauth package so T5 can derive from it. TDD: failing tests first in packages/oauth/_test/github-copilot.test.ts — (a) successful login stores payload containing models with `{id, transport}` entries (mock fetch); (b) models-fetch failure still returns authenticated and stores payload without models.
  Must NOT do: no transport metadata in any public config type; no CLI changes here; no retry loops.
  Parallelization: Wave 1 | Blocked by: - | Blocks: T4,T6
  References: packages/oauth/src/github-copilot/index.ts:72-113,200-221,256-290 (modelEntry/transport); packages/oauth/src/github-copilot/schema.ts (modelsResponseSchema :38-40); packages/oauth/src/oauth-provider.ts:54-98 (OAuthLoginPayload, store); packages/oauth/src/store.ts:42-68; existing test patterns packages/oauth/_test/github-copilot.test.ts:50,161-166
  Acceptance criteria: `bun run test` green in packages/oauth; new tests (a)(b) present; login failure path proven by test with mocked failing /models fetch.
  QA scenarios: happy = mocked full login stores models (assert via Auth.get); failure = mocked /models 500 → login still authenticated, payload lacks models, warning emitted; Evidence .omo/evidence/task-2-oauth-dynamic-models.txt
  Commit: Y | feat(oauth): store vendor model list in login payload

- [x] 3. packages/server: shared deriveOAuthAlias helper with collision guard
  What to do: New small module packages/server/src/oauth-alias.ts exporting `deriveOAuthAlias(modelIds: readonly string[], configAlias: Readonly<Record<string, AliasConfig>> | undefined): Readonly<Record<string, AliasConfig>>`. Rules: (1) every model id M becomes a self-alias `{ model: M, preserve: false }`; (2) config alias entries are merged ON TOP — a config key equal to M replaces the auto entry; (3) an auto self-alias for M is OMITTED when any config alias entry targets model M with `preserve: true` (otherwise `modelRoutes` emits duplicate `provider/M` routes → RouterModelCollisionError at startup — mirror of normalizeAliasPreserve, packages/types/src/provider.ts:111-124, commit 2e5b3fb); (4) config alias entries whose target model is NOT in modelIds are KEPT but produce a single `console.warn` naming provider-unknown targets (runtime replacement for the parse-time validation oauth loses in T1). Deterministic output order: auto self-aliases in modelIds order, then config-only keys in config order. TDD: failing unit tests first in packages/server/_test/oauth-alias.test.ts covering: plain derivation; config rename override; config key == model id; preserve:true collision omission; unknown-target warn (spy console.warn); empty modelIds with config alias only; both empty.
  Must NOT do: no Router changes; no I/O in the helper (pure function); no throw on unknown targets.
  Parallelization: Wave 2 | Blocked by: T1 | Blocks: T4,T5
  References: packages/core/src/index.ts:202-223 (addRoute collision + modelRoutes semantics); packages/types/src/provider.ts:103-124 (normalizeAliasPreserve mirror); packages/types/src/common.ts:15-29 (AliasConfig shape); router collision test packages/core/_test/router.test.ts:121-145
  Acceptance criteria: `bun test _test/oauth-alias.test.ts` green (workdir packages/server); constructing `new Router([...])` in a test with derived alias containing a preserve:true config entry does NOT throw RouterModelCollisionError.
  QA scenarios: happy = derivation matrix tests pass; failure = deliberately include duplicate route pair in a control test to prove the collision WOULD throw without the guard; Evidence .omo/evidence/task-3-oauth-dynamic-models.txt
  Commit: Y | feat(server): add oauth alias derivation helper

- [x] 4. packages/server: Copilot runtime derives routes from payload.models
  What to do: In `createGitHubCopilotRuntimeProvider` (packages/server/src/oauth-runtime.ts:25-76): build `modelIds` from `cachedModels` (:31, payload.models); set instance `alias: deriveOAuthAlias(modelIds, config.alias)` and `models: modelIds` (payload-derived; replace the `config.models` spread at :64 — after T1 `config.models` no longer exists, remove all references). Keep transport dispatch untouched (:32,72-74,114-116). Degradation: when `payload` exists but `cachedModels` is undefined/empty (stale pre-migration login or fetch-failure login), emit ONE `console.warn` at materialization ("<id>: no cached Copilot model list — run `aio-proxy provider login copilot` to sync; only config alias routes are exposed") and derive from `[]` (config.alias-only exposure); extend the `ensureAvailable` error (:67-71) to mention model re-sync when models are missing. TDD: failing tests first in packages/server/_test/oauth-provider-runtime.test.ts — (a) payload with models + NO config alias → instance.alias contains self-aliases, Router resolves each id (fixture :28-71 currently supplies config models/alias — REWRITE to the new shape: config = {kind, vendor} only); (b) payload models + config alias rename → both routes resolve, config wins on collision; (c) payload WITHOUT models → warn emitted, only config alias routes, ensureAvailable message mentions re-login; (d) transport dispatch still selects messages/responses per cached transport.
  Must NOT do: no live fetch; no change to the three inner AI SDK providers (:35-58); no chatgpt edits here.
  Parallelization: Wave 2 | Blocked by: T1,T2,T3 | Blocks: T7
  References: packages/server/src/oauth-runtime.ts:14-129; packages/server/src/runtime.ts:4-15 (OAuthProviderInstance keeps instance-level models?/alias?); packages/server/src/provider-runtime.ts:41-47 (materialize entry); packages/core/src/index.ts:177-223 (Router consumption); test fixture packages/server/_test/oauth-provider-runtime.test.ts:28-97
  Acceptance criteria: `bun test _test/oauth-provider-runtime.test.ts` green (workdir packages/server); a Router built from the materialized provider resolves a payload model id end-to-end in test.
  QA scenarios: happy = fixture (a)/(b) resolve routes; failure = fixture (c) stale payload → warn + RouterModelNotFoundError for un-aliased id, ensureAvailable rejection message asserted; Evidence .omo/evidence/task-4-oauth-dynamic-models.txt
  Commit: Y | feat(server): derive copilot routes from cached vendor models

- [x] 5. packages/server: ChatGPT runtime derives routes from the static vendor list
  What to do: In `createOpenAIChatGPTRuntimeProvider` (packages/server/src/oauth-chatgpt-runtime.ts:31-66): import the now-exported `OPENAI_CHATGPT_MODELS` (T2) — the in-code list IS the ChatGPT vendor truth (payload copies go stale when code updates); set instance `alias: deriveOAuthAlias(staticIds, config.alias)` and `models: staticIds`; REMOVE both `config.models` spreads (:39,:56 — field gone after T1). This is the complete Bug B fix (bare config.alias passthrough is NOT enough — with no config alias the instance would expose nothing; Metis HIGH #1). In `refreshPayload` (:86-91) write `models: OPENAI_CHATGPT_MODELS` instead of copying the old `payload.models` (stale-copy fix). Keep `parseChatGPTPayload` requiring payload.models (:106-126) — chatgpt logins always write it (openai-chatgpt/index.ts:95), fixtures must include it. TDD: failing tests first in packages/server/_test/oauth-chatgpt-runtime.test.ts (existing fixture :9 has `models: [{id:"gpt-5.5"}]` — extend): (a) materialized instance exposes self-alias routes for every OPENAI_CHATGPT_MODELS id with config = {kind, vendor} only; (b) config alias rename merges (config wins); (c) refresh persists the CURRENT static list, not the payload copy; (d) payload missing models still throws ChatGPTLoginRequiredError from ensureAvailable (unchanged contract).
  Must NOT do: no fallback that silently accepts payloads without models; no fetch wrapper behavior changes beyond refreshPayload models line; no copilot edits here.
  Parallelization: Wave 2 | Blocked by: T1,T3 | Blocks: T7
  References: packages/server/src/oauth-chatgpt-runtime.ts:31-138; packages/oauth/src/openai-chatgpt/index.ts:21-26,86-99; packages/oauth/src/openai-chatgpt/schema.ts:16-21 (ChatGPTPayload.models required); packages/server/_test/oauth-chatgpt-runtime.test.ts:9
  Acceptance criteria: `bun test _test/oauth-chatgpt-runtime.test.ts` green (workdir packages/server); Router built from materialized chatgpt provider resolves "gpt-5.5" with a bare {kind, vendor} config.
  QA scenarios: happy = bare-config route resolution test; failure = payload without models → ChatGPTLoginRequiredError asserted; refresh-staleness control test proves old list would persist without the fix; Evidence .omo/evidence/task-5-oauth-dynamic-models.txt
  Commit: Y | fix(server): expose chatgpt oauth routes from static vendor models

- [x] 6. packages/cli: provider login writes only {kind, vendor}
  What to do: In `providerLogin` (packages/cli/src/provider-commands.ts:67-93): write `providers[result.providerId] = { kind: "oauth", vendor }` — DROP the `models` spread (:89) and DROP the CLI-side copilot `Auth.set` models duplication (:83-85; T2 makes login own payload sync). Remove the now-dead `models` field from `LoginForCliResult` (:42-46) and the `models()` calls in `runCopilotLoginForCli` (:122) / `runChatGPTLoginForCli` (:148) — login itself now syncs payload; CLI needs no model handling. Keep the fake-login env paths (:96-101,:128-133) — fakes set payload directly; update packages/cli/_test/provider-commands.test.ts fixtures (:57-131) so fake payloads INCLUDE `models` (copilot: `[{id, transport}]` entries) and assert the written config entry equals exactly `{kind, vendor}` (no models key). Config file write stays AFTER login resolves (ordering contract from T2). TDD: failing tests first — (a) copilot login writes {kind, vendor} only; (b) chatgpt login writes {kind, vendor} only; (c) written config parses via ConfigSchema and the file write happens after Auth payload is readable (assert Auth.get inside the test after providerLogin).
  Must NOT do: no prompt/UX changes; no new CLI flags; do not remove the fake env mechanism.
  Parallelization: Wave 2 | Blocked by: T1,T2 | Blocks: T8
  References: packages/cli/src/provider-commands.ts:38-151; packages/cli/_test/provider-commands.test.ts:57-131; packages/types/src/config.ts:15-29 (parse target); reload trigger context packages/server/src/config-watcher.ts:8-32
  Acceptance criteria: `bun run test` green in packages/cli; `rtk rg -n "models" packages/cli/src/provider-commands.ts` returns no config-write usage.
  QA scenarios: happy = fake copilot + chatgpt logins produce minimal config entries and routable payloads; failure = fake login result WITHOUT payload.models still writes valid config and does not crash CLI; Evidence .omo/evidence/task-6-oauth-dynamic-models.txt
  Commit: Y | fix(cli): stop writing models into oauth provider config

- [x] 7. packages/server: /v1/models lists alias-derived ids only
  What to do: In `exposedModels` (packages/server/src/server.ts:109-126) DELETE the raw-models fallback loop (:120-124) so listing = alias keys + preserved original ids exactly (design spec :144; reverts the drift introduced by commit 4dd64d3). OAuth providers keep full listings automatically because T4/T5 put derived aliases on the instances. TDD: failing tests first in packages/server/_test/server.test.ts — (a) REWRITE the test at :75-101 ("models but no alias → listed") to assert those ids are NOT listed; (b) oauth provider materialized from payload/static models IS listed without any config alias; (c) alias + preserve listing unchanged (:55-74 keeps passing); (d) disabled providers still excluded (:102-123).
  Must NOT do: no response shape changes (object/list envelope stays); no dashboard endpoint changes.
  Parallelization: Wave 3 | Blocked by: T4,T5 | Blocks: F*
  References: packages/server/src/server.ts:40-126; packages/server/_test/server.test.ts:55-123; docs/superpowers/specs/2026-07-05-model-alias-config-design.md:144; git context: commit 4dd64d3 "fix(server): expose provider.models via /v1/models" is being superseded — note this in the commit body
  Acceptance criteria: `bun test _test/server.test.ts` green (workdir packages/server); GET /v1/models in test returns ONLY alias-derived ids for a mixed api+oauth fixture.
  QA scenarios: happy = mixed-provider listing matches expectation exactly; failure = api provider with models-only returns empty data for that provider (asserted), and requesting one of those ids returns the 404 MODEL_NOT_FOUND sentinel (consistency between listing and routing proven); Evidence .omo/evidence/task-7-oauth-dynamic-models.txt
  Commit: Y | fix(server): list only alias-exposed models in /v1/models

- [x] 8. Example config migration + docs sweep
  What to do: Rewrite aio-proxy.json: carpool keeps `models: ["gpt-5.5"]` and gains `"alias": { "gpt-5.5": "gpt-5.5" }` (string shorthand — parses to {model, preserve:false}); chatgpt entry stays exactly `{ "kind": "oauth", "vendor": "openai-chatgpt" }`. Run `bun run build` (regenerates packages/types/dist/config.schema.json used by the file's $schema) and validate the file parses: `bun -e` script calling ConfigSchema.parse on the file. Sweep docs: `rtk rg -ni "models" AGENTS.md docs/ README.md npm/ --glob '!docs/superpowers/**'` and update any instruction that tells users to put `models` on oauth providers (historical spec/plan docs under docs/superpowers stay untouched). TDD-lite: the parse-validation script IS the test; commit it as packages/types/_test/example-config.test.ts if trivial (reads ../../aio-proxy.json, expects parse success + oauth entry has no models key).
  Must NOT do: do not touch the committed apiKey value or restructure the example beyond the alias addition; do not edit historical spec/plan documents.
  Parallelization: Wave 3 | Blocked by: T1,T6 | Blocks: F*
  References: aio-proxy.json:1-20; packages/types/src/common.ts:15-22 (string shorthand); packages/types/rslib.config.ts:5-14; AGENTS.md (routing section — currently silent on oauth models, verify)
  Acceptance criteria: ConfigSchema.parse succeeds on the migrated file (test or script output captured); `bun run build` completes; grep sweep output shows zero stale instructions.
  QA scenarios: happy = parse passes + schema regen diff reviewed; failure = corrupt the alias target to a model NOT in models and assert parse FAILS for carpool (api/ai-sdk validation still live); Evidence .omo/evidence/task-8-oauth-dynamic-models.txt
  Commit: Y | chore(config): migrate example config to alias-based exposure

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit — read this plan top to bottom, diff `git log`/changed files against every Must-have and Must-NOT-have; verify each todo's acceptance command was actually run (re-run spot checks). Evidence .omo/evidence/final-F1-oauth-dynamic-models.txt
- [x] F2. Code quality review — repo gates: `bun run test` (turbo, all packages), `bunx biome check .`, `bun run build` (schema.json regen clean); review new modules for the 250-LOC ceiling and dead exports. Evidence .omo/evidence/final-F2-oauth-dynamic-models.txt
- [x] F3. Real manual QA (agent-executed, no human) — in a temp `AIO_PROXY_HOME`, seed Auth with a fake copilot payload (models incl. transports) and a fake chatgpt payload via `Auth.set`; write a config with ONLY `{kind, vendor}` oauth entries + the migrated carpool entry; boot the server via `createServer` on an ephemeral port; assert (1) GET /v1/models lists copilot payload ids + OPENAI_CHATGPT_MODELS ids + carpool alias, (2) a request for a copilot model id resolves (Router path — may stub invoke), (3) rewriting the config file triggers reload (watch server-reload.test.ts pattern) and routes refresh from a CHANGED payload. Evidence .omo/evidence/final-F3-oauth-dynamic-models.txt
- [x] F4. Scope fidelity — confirm NO live vendor fetch was added to startup/reload paths (`rtk rg -n "fetch" packages/server/src/oauth-runtime.ts packages/server/src/provider-runtime.ts packages/server/src/server-state.ts` reviewed), Router untouched (`git diff --stat packages/core/src/index.ts` empty), api/ai-sdk models semantics unchanged. Evidence .omo/evidence/final-F4-oauth-dynamic-models.txt

## Commit strategy
Conventional commits (commitlint enforced, .commitlintrc.json). One commit per todo, in dependency order:
1. `feat(types): scope models config to api and ai-sdk providers` (T1)
2. `feat(oauth): store vendor model list in login payload` (T2)
3. `feat(server): add oauth alias derivation helper` (T3)
4. `feat(server): derive copilot routes from cached vendor models` (T4)
5. `fix(server): expose chatgpt oauth routes from static vendor models` (T5)
6. `fix(cli): stop writing models into oauth provider config` (T6)
7. `fix(server): list only alias-exposed models in /v1/models` (T7, body notes it supersedes 4dd64d3)
8. `chore(config): migrate example config to alias-based exposure` (T8)
No force-push, no amends of pushed commits; lefthook hooks run as configured.

## Success criteria
- Fresh OAuth login (fake env path) yields: config entry exactly `{kind, vendor}`, Auth payload carrying the vendor model list, and a server that ROUTES those models with zero manual config — the original "zero routes after login" defect is dead.
- `/v1/models` output equals the routable surface exactly (no listed-but-404 ids), for all provider kinds.
- OAuth config `models` is gone from the schema; legacy configs with the key still parse (stripped); api/ai-sdk semantics unchanged.
- ChatGPT: hand-written config alias routes AND bare-config auto routes both resolve (Bug B dead); token refresh persists the current static list.
- Copilot: transport dispatch unchanged; stale payload (no models) degrades to config-alias-only with an actionable warning naming re-login.
- No network fetch added to server startup/reload/router construction (CPU-only swap preserved).
- All bun:test suites green repo-wide, biome clean, build (incl. config.schema.json regen) clean.
