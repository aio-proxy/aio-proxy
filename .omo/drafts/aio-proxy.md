---
slug: aio-proxy
status: awaiting-approval
intent: clear
pending-action: write .omo/plans/aio-proxy.md
approach: |
  Bun monorepo (6 packages) building a local-first AI gateway CLI that exposes 4
  wire-protocol entrypoints (OpenAI Chat / OpenAI Responses / Anthropic Messages /
  Gemini generateContent) and dispatches to providers configured as api /
  subscription / ai-sdk. Same-protocol native-endpoint requests take a
  byte-passthrough fast path; cross-protocol requests funnel through Vercel
  AI SDK 7 (LanguageModel V3) for transformation. ai-sdk providers are loaded
  from a built-in BUNDLED_PROVIDERS map plus an opencode-style runtime
  `npm.add()` fallback enabled by `Bun.build({ compile: { autoloadPackageJson: true } })`.
  Cross-platform binaries via `bun build --compile --target=...` published as
  per-platform npm sub-packages of `aio-proxy-ai` (opencode pattern) plus
  GitHub Releases + curl|sh installer. React+shadcn dashboard embedded as
  `Bun.embeddedFiles` static assets, served by the same Hono server on a
  second port. SQLite traces table (7-day TTL) + usage table (forever) for
  observability.
---

# Draft: aio-proxy

## Components (topology ledger)

| id | outcome | status | evidence |
|---|---|---|---|
| types | zod v4 schemas + TS types for config, IR, trace events; zero ai-sdk runtime imports; `composite: true` | active | n/a (greenfield) |
| i18n | paraglide-js compile-time codegen (D77); `messages/{en,zh-CN}.json` source; per-message tree-shake; shared by CLI + dashboard; missing key = TS compile error | active | openclaw `src/wizard/i18n/*` resolve pattern |
| core | Provider runtime, ingress adapters (4), egress adapters (4), ai-sdk wrapper (contained in core/ai-sdk-bridge), router, trace recorder, npm fallback loader, drizzle schema, `open-db.ts` single entrypoint, migrations.manifest.ts | active | n/a |
| auth-flows | OAuth/device-code flows + token store via `openDb()` + `Auth.cas` for subscription writes; vendor presets (github-copilot first); single-flight refresh + provider generation guard | active | opencode `packages/opencode/src/plugin/github-copilot/copilot.ts:222-336` |
| server | Hono routes (4 ingress protocols + dashboard Hono RPC API + SSE event stream + `/dashboard/auth` returning summary only) | active | n/a |
| dashboard | Vite + React 19 + Tailwind v4 + shadcn (preset b6a2WHJKc baseline COMMITTED) + TanStack family (router/query/table/form/virtual) + paraglide via workspace; embedded into binary at compile time; kebab-case files | active | n/a |
| cli | commander 15 entrypoint + paraglide `m.*()` help/errors + `--lang` argv pre-scan + bun build --compile target, init wizard, host-target binary smoke spike in todo 4 | active | openclaw `src/cli/*` precomputed help pattern |

## Open assumptions (announced defaults)

| assumption | default | rationale | reversible? |
|---|---|---|---|
| `~/.config/aio-proxy/` is writable on first run | yes | wizard fails fast otherwise with a clear error | yes - `--config <path>` flag |
| User has internet for first-launch models.dev pull | not required | bundled fallback catalog ships with binary | yes |
| `bun` is NOT a runtime requirement on user machines | true | binary is self-contained; runtime npm fallback uses bundled `Bun.spawn` of in-binary `bun` | yes |
| trace bodies do NOT include raw OAuth tokens | enforced via Authorization/api-key mask middleware | safety default | yes - lenient mode in P2 |
| MVP doesn't need fallback chains / load-balance | true | adds product complexity without clear MVP demand | yes - phase 2 `routes` array |

## Findings (cited - path:lines)

### opencode provider+IR architecture (sst/opencode @ 846d548)
- BUNDLED_PROVIDERS map drives lazy `await import("@ai-sdk/...")` per `model.api.npm`: `packages/opencode/src/provider/provider.ts:107-134`, `:1736-1744`.
- Runtime npm fallback when not bundled: `packages/opencode/src/provider/provider.ts:1747-1763` calls `Npm.add()` then `import(pathToFileURL)` and picks first `create*` export.
- Npm cache directory: `xdgCache/opencode/packages/<sanitize>/node_modules/<pkg>` (`packages/core/src/npm.ts:74-79,124-129`).
- Build script uses `Bun.build({ external: ["node-gyp"], compile: { autoloadPackageJson: true } })`: `packages/opencode/script/build.ts:168-184`.
- NPM publish meta package `opencode-ai` with `optionalDependencies` per platform sub-package: `packages/opencode/script/publish.ts:54-69`.
- Custom Copilot LanguageModel via `createOpenaiCompatible` (lowercase, opencode's own) returning `OpenAICompatibleChatLanguageModel`: `packages/core/src/github-copilot/copilot-provider.ts:52-74`.
- Copilot device-code flow + endpoint token refresh: `packages/opencode/src/plugin/github-copilot/copilot.ts:222-336,160-178`.
- Auth file 0600 at `~/.local/share/opencode/auth.json`: `packages/opencode/src/auth/index.ts:10,73-80`.
- ai-sdk deps locked at `ai@6.0.168` + `@ai-sdk/anthropic@3.0.82` etc.: `packages/opencode/package.json:58-76`.
- IR is hybrid: ai-sdk `streamText` + opencode's own `LLMRequest`/`Message`/`LLMEvent` (Effect Schema): `packages/llm/src/schema/messages.ts:169-284`.
- No byte-level passthrough for LLM responses; everything normalized through LLMEvent: `packages/opencode/src/session/llm.ts:276-378`.

### Comparable projects
- claude-code-router: protocol enum + raw JSON body passthrough wrapper, conversion delegated to `@the-next-ai/ai-gateway`: `src/server/gateway/service.ts:672-742,1577-1592,1676-1713`.
- LiteLLM: OpenAI-compatible custom IR (`ModelResponse` w/ `tool_calls`); SUPPORTS both IR transcode AND byte passthrough endpoints: `litellm/proxy/pass_through_endpoints/streaming_handler.py:27-84`.
- Continue openai-adapters: OpenAI Chat schema as adapter IR; Anthropic/Gemini transcoded chunk-by-chunk into `ChatCompletionChunk`.
- Vercel AI SDK current state: `ai@7.0.4` depends on `@ai-sdk/provider@4.0.0`; LanguageModel V2/V3/V4 all coexist; V3 used by `@ai-sdk/gateway`. `streamText` accepts V2/V3 providers.

### Bun cross-compile facts (Bun 1.3.14)
- Cross-compile from any host to any target via `--target=bun-{darwin,linux,windows}-{arm64,x64}[-musl][-baseline|-modern]`: docs/bundler/executables.mdx:45-46,231-240.
- `--no-bundle` NOT supported with `--compile`; runtime dynamic import requires `--external <pkg>` + `--compile-autoload-package-json` + node_modules accessible at runtime: docs/bundler/executables.mdx:1220-1228,409-424.
- Embed dirs via `with { type: "file" }` or `Bun.embeddedFiles`: docs/bundler/executables.mdx:675-928.
- `bun:sqlite` works in compiled binary; embedded DB via `with { type: "sqlite", embed: "true" }`: docs/bundler/executables.mdx:648-832.
- Binary size for Hono-class apps: ~90-130 MB (Bun runtime overhead).
- macOS: `codesign` directly on the binary (no .app wrapper); JIT entitlements required.
- Real-world example: codebase-foundation/codebase-cli ships 5 targets via matrix.

### npm name availability
- `aio-proxy` and `@aio-proxy/*` are unclaimed on npm registry (verified via registry.npmjs.org/aio-proxy 404).

## Decisions (with rationale)

### Architecture (load-bearing)
- **D1**: Hybrid request strategy. Same-protocol + native-endpoint provider → byte passthrough; everything else → ai-sdk transformation. Rationale: balances code simplicity (most calls don't need transformation) with semantic fidelity for cross-protocol routing.
- **D2**: Passthrough qualifies ONLY when `ingress.protocol === provider.protocol` AND `provider.kind === "api"` AND provider is a vendor-native endpoint (openai/anthropic/google official). Subscription, openai-compatible third-party, and ai-sdk providers all transcode through ai-sdk.
- **D10**: IR = Vercel AI SDK's `LanguageModelV2/V3` + `ModelMessage`. We do not maintain our own neutral IR. Rationale: minimal code, ai-sdk is the most mature multi-provider transcoder; tradeoff is coupling with ai-sdk versioning.
- **D11**: Lock `ai@^7`, target `LanguageModelV3` first; `streamText` accepts V2/V3 providers transparently. V4 deferred.
- **D21''**: Mixed provider loading (opencode-equivalent). 8-package BUNDLED map (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`, `@ai-sdk/mistral`, `@ai-sdk/groq`, `@ai-sdk/xai`, `@openrouter/ai-sdk-provider`) hot-bundled into binary; cache miss → `npm.add(pkg)` to `~/.config/aio-proxy/cache/packages/<sanitize>/node_modules/` then `await import(pathToFileURL)`. Build sets `compile.autoloadPackageJson=true`.

### Routing & config
- **D4**: Global alias table, `model: "<alias>"` is the route key; explicit override syntax `"<provider-id>/<alias>"` for collision resolution.
- **D27 (revised)**: Top-level config schema `{ server, providers }`. NO top-level `routes` array (deferred to Phase 2 if fallback chains needed). Each provider's `models[]` accepts shorthand string OR `{ alias, id }` pair where `id` is the upstream model id sent to the provider.
- **D30**: `provider.enabled?: bool` for soft-disable.
- **D32 (revised)**: MVP integrates models.dev catalog. Pull `https://models.dev/api.json` on startup, cache 24h at `~/.config/aio-proxy/cache/models.json`. Bundled fallback ships with binary for offline / pull-failure case. Dashboard model picker auto-completes from the cache.
- **D33 (revised)**: First-run interactive init wizard (provider checklist → API key prompts → optional Copilot OAuth login → write config.jsonc → start serving). Wizard skipped if config.jsonc exists.
- **P4**: `$ENV_VAR` interpolation reads `process.env` only; no `.env` file support.

### Wire / server
- **D17→D24**: MVP includes ALL 4 ingress protocols (OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini generateContent) + their stream variants.
- **D15**: Protocol routes mirror upstream wire format paths so clients only change `baseURL`: `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1beta/models/:model::generateContent` (+ `:streamGenerateContent`), `/v1/models`, `/v1/messages/count_tokens`, `/v1beta/models`. Dashboard/control routes use `/dashboard/*` on the dashboard/control surface, not `/admin/*`.
- **D5**: MVP runs unauthenticated, listening on `127.0.0.1` only. Token middleware insertion point reserved for Phase 2.
- **D8**: Hono on Bun.serve adapter. Dashboard/control API is exposed through Hono RPC (`hc<AppType>()`), following Hono's larger-app pattern: compose route modules with chained `.route()`, export `type AppType = typeof routes`, keep server/dashboard Hono versions aligned, and precompile client types if IDE/type performance regresses.
- **D6**: Same-process dual-port. `aio-proxy serve [--dashboard]`. `aio-proxy dashboard` is a convenience: detect → spawn-if-missing → `open http://127.0.0.1:<dashboard-port>`.
- **D39**: Default ports `22078` (API) / `22079` (Dashboard).
- **D12**: Hot reload via Bun file watcher + dashboard Hono RPC API. Provider instances stored as immutable record; atomic swap on config change. In-flight requests use old config.
- **D16**: `/dashboard/events` SSE endpoint streams `trace.start` / `trace.delta` / `trace.end` / `config.changed` to dashboard.
- **D115** (user-driven, after OpenClaw check): Do NOT call the local control surface `admin`. OpenClaw names this concern "Control UI" and reserves internal UI assets under `__openclaw__`, while resource operations use noun routes such as `/sessions`, `/tools`, `/api/...`. aio-proxy adopts `/dashboard/*` for the local dashboard/control Hono RPC API because the product is local-first, not a multi-tenant admin console.

### Subscription / auth
- **D9**: MVP supports GitHub Copilot only via device-code OAuth. ChatGPT deferred to Phase 2 (technically feasible per LiteLLM/opencode but signaled as unstable).
- **P1**: Vendor presets live in `packages/auth-flows/presets/<vendor>.ts`, exporting `{ authFlow, modelHints, defaultBaseURL }`. ChatGPT/Cursor-pro/Claude-code follow same shape in future phases.

### Dashboard
- **D7**: Vite + React + shadcn/ui static SPA. Built dist embedded via `with { type: "file" }` + `Bun.embeddedFiles`.
- **D36**: No chat playground in MVP. Stay scoped as a proxy.

### Observability (revised after grill)
- **D40 (revised)**: SQLite always-on. TWO tables:
  - `traces`: full req/resp body (Authorization/api-key masked). 7-day TTL with background prune job.
  - `usage`: aggregate row per request `{ ts, provider_id, model_alias, input_tokens, output_tokens, cost, status, latency_ms }`. NEVER deleted.
- **D41 (revised)**: Auto-prune `traces` after 7 days; manual `aio-proxy trace prune` for ad-hoc cleanup; `usage` permanent.

### Errors / capabilities
- **D20**: Error responses translated to ingress protocol's native error envelope. Retry exactly once on provider INSTANTIATION failures (token expired → auth-flows.refresh, network refused before HTTP). NEVER retry once a request has been sent (provider may have charged).
- **D25 (revised)**: Capability mismatches silently drop unsupported fields via ai-sdk's built-in transformation. No 400-rejection mode in MVP.

### Security
- **D22**: Defaults: listen `127.0.0.1` (`--host 0.0.0.0` requires explicit flag + warning); dashboard Hono RPC API local-only with Origin/Sec-Fetch CSRF check; `aio-proxy.db` chmod `0600` on first create (single source of secret-at-rest); `$ENV_VAR` interpolation in config; trace body redacted via header denylist + JSON key denylist + URL query denylist + 256KB cap (config `trace.bodyMode: "redacted"|"off"|"full"`, default `"redacted"`).

### CLI
- **D23 (revised)**: Single-noun command tree.
  ```
  aio-proxy serve [--host 127.0.0.1] [--port 22078] [--dashboard] [--config <path>]
  aio-proxy dashboard
  aio-proxy provider list [--probe]
  aio-proxy provider login github-copilot
  aio-proxy provider logout <id>
  aio-proxy model list
  aio-proxy trace prune
  aio-proxy --version
  ```
- **D31**: Provider connectivity is lazy. Health derived from recent trace success-rate. `--probe` flag does explicit HEAD/list-models check on demand.

### Path conventions
- **D26 (revised)**: Single directory `~/.config/aio-proxy/` for `config.jsonc` + `aio-proxy.db` (one SQLite file shared by `auth` / `traces` / `usage` / `models_dev_cache` / future `config_snapshots`) + `cache/` (npm fallback packages). Windows uses `%APPDATA%\aio-proxy\`. **No separate `auth.json`** — D45 collapsed it into the SQLite `auth` table.

- **D44**: SQLite filename is `aio-proxy.db` (not `traces.db`) — the file is a generic application state store, not scoped to traces. Hosts `traces`, `usage`, `auth`, `models_dev_cache`, future tables.

- **D45**: Auth credentials live in `aio-proxy.db` `auth` table (NOT in a separate `auth.json` file). Schema: `(vendor, provider_id, payload TEXT, updated_at)`. Payload is opaque vendor-defined JSON. File-level `0600` protection moves from `auth.json` to `aio-proxy.db`.

- **D46**: Auth-table access is **code-layer isolated**. ONLY `packages/auth-flows/store.ts` may `SELECT/INSERT/UPDATE/DELETE FROM auth`. Other packages get a `db()` factory that returns a handle with no `auth`-table queries in its API surface. `/dashboard/auth GET` returns `{ vendor, providerId, hasToken, expiresAt, accountLabel }` only — never raw payload. Trace export and `aio-proxy trace prune` operate on explicitly-named `traces` / `usage` tables. Architectural rule verified by tests plus final F1 mechanical grep: `grep -rE "FROM auth\\b" packages/{core,server,cli,dashboard}/src` must return zero matches.

### Monorepo / toolchain
- **D14**: 6 packages.
  - `packages/types` - zod v4 schemas + TS types
  - `packages/core` - provider runtime, IR, adapters, router, trace
  - `packages/auth-flows` - OAuth flows + token store + vendor presets
  - `packages/server` - Hono routes (uses core + auth-flows)
  - `packages/dashboard` - Vite SPA (independent build)
  - `packages/cli` - commander entrypoint + bun build --compile target
- **D28**: TypeScript ^5.7 strict + `noUncheckedIndexedAccess`; Biome (format + lint + organize-imports); `bun test`.
- **D29**: zod v4 for schemas.
- **P5**: Bun pinned to `1.3.14` via `oven-sh/setup-bun@v2` in CI.

### Testing
- **D18**: Three layers.
  - Unit (`bun test`): adapter golden-files for each protocol; alias resolver; config zod validation; ai-sdk mocked at `LanguageModelV2.doStream`.
  - Integration (Hono `testClient`): all 4 protocol routes (passthrough + cross-protocol); dashboard Hono RPC API; Copilot auth with mocked GitHub device endpoint.
  - E2E: real Bun server + mock OpenAI/Anthropic/Gemini upstream; verify with each protocol's official SDK; SSE chunks asserted.
  - Quality gates: Biome lint + tsc strict; CI runs all 3 layers.

### Distribution
- **D19**: Multi-channel.
  - GitHub Releases: matrix-build 5 targets (`bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64-modern`, `bun-linux-arm64`, `bun-windows-x64`); upload `.tar.gz` / `.zip`.
  - npm meta package `aio-proxy-ai` (binary launcher) + per-platform sub-packages (`aio-proxy-darwin-arm64` etc.) as `optionalDependencies` (opencode pattern).
  - `curl https://aio-proxy.dev/install.sh | sh` (Phase 1).
  - Homebrew tap, scoop: Phase 2.
- **D34**: No telemetry collected.
- **D35**: MIT license.

### Phasing
- **D37**: 8 milestones for Phase 1, each agent-verifiable end-to-end.
  - M1: monorepo skeleton + Hono + 4 mock ingresses + zod + biome+tsc passing
  - M2: openai-compatible api provider + OpenAI Chat passthrough + ai-sdk OpenAI↔Anthropic crosstalk
  - M3: Anthropic Messages + Gemini + OpenAI Responses ingress + passthrough + IR Fitness fixtures
  - M4: BUNDLED_PROVIDERS map + gated runtime npm fallback (opencode-style, self-spawn via process.execPath)
  - M5: GitHub Copilot OAuth device flow + single-flight refresh + subscription provider class + ProviderPreset registry + wizard
  - M6: Dashboard skeleton + provider CRUD + alias editor + trace+usage viewer + models.dev autocomplete + auth-safe dashboard
  - M7: bun build --compile matrix × 5 platforms + GitHub Releases CI + npm publish (meta + sub-packages with diagnostic shim) + install.sh
  - M8: full e2e suite (HTTP-level mocks, real SDKs, IR Fitness regression) + first 0.1.0 release + README

### New decisions added during high-accuracy review (Oracle/Momus revisions)
- **D44**: SQLite filename is `aio-proxy.db` (replaces `traces.db`). Hosts `traces`/`usage`/`auth`/`models_dev_cache`/future tables. Per Q43.
- **D45**: `auth.json` is GONE. All token storage migrates into `aio-proxy.db` `auth` table. File-level 0600 protection moves to the db file. Per Q46 + your direct request.
- **D46**: Auth-table access is **code-layer isolated**. ONLY `packages/auth-flows/src/store.ts` may `SELECT/INSERT/UPDATE/DELETE FROM auth`. Tests and final F1 mechanical grep enforce. `/dashboard/auth` GET returns redacted summary only. Per Q46.
- **D47** (Oracle MAJOR): Passthrough boundary is a **derived flag** computed at config-load: `passthrough = (ingress.protocol === provider.protocol) && (provider.kind === "api") && (provider.vendor in {"openai-native","anthropic-native","google-native"})`. Azure / openai-compatible-3rd-party / subscription / ai-sdk all transcode through ai-sdk. The flag is exposed via `GET /dashboard/providers/:id` for debuggability.
- **D48** (Oracle MAJOR): All ai-sdk runtime imports are contained in `packages/core/src/ai-sdk-bridge/*` ONLY. `packages/types` does not re-export ai-sdk types — it exposes `AioModelMessage` / `AioStreamPart` as project-owned aliases. Tests and final F1 mechanical grep enforce.
- **D49** (Oracle MAJOR): SSE `/dashboard/events` uses bounded per-connection queue (1000 events / 5MB cap); on overflow emit `events.dropped` then close. `trace.delta` events coalesce to ≤ one per 50ms per `trace_id`.
- **D50** (Oracle BLOCKING): runtime npm install via `Bun.spawn([process.execPath, "add", pkg, "--no-save"], { env: { BUN_BE_BUN: "1", ... } })` — NEVER `["bun", ...]`. The compiled binary self-spawns as bun runtime; no user PATH dependency.
- **D51** (Oracle BLOCKING): runtime `npm.add` is **gated**. `serve` does NOT auto-install. Triggered ONLY by explicit `aio-proxy provider install <pkg>` CLI or dashboard "Install" button with risk acknowledgment dialog. Reduces RCE-via-config attack surface to require explicit user action.
- **D52** (Oracle MAJOR): Subscription token refresh uses **per-providerId single-flight** (`Map<string, Promise<EndpointToken>>`). Concurrent expirations coalesce to one refresh HTTP call.
- **D53** (Oracle MAJOR): Hot-reload uses 4-stage validation pipeline (parse → build instances → build router → alias-collision check); ANY stage fail → keep OLD config serving. Atomic ref swap on success.
- **D54** (Oracle MAJOR): Trace body redaction default is `"redacted"` mode covering header denylist, JSON-key denylist, URL-query denylist, 256KB cap. `bodyMode: "off"|"full"` available via config; never the default.
- **D55** (Oracle MAJOR): `usage` table uses `PRAGMA user_version` forward-only migrations; schema changes always include a migration test.
- **D56** (Oracle MAJOR): `previous_response_id` / `store: true` / `background: true` in OpenAI Responses ingress are **rejected with 501** (NOT silent-drop per D25). These three fields are the documented exception to silent-drop.
- **D57** (Oracle MAJOR): IR Fitness Contract table (in plan) is the single source of truth for provider-specific field carriage; every adapter PR must update the table or pass its fixture rows.
- **D58** (Oracle MINOR): Provider instance immutability — reload always builds fresh instances; in-flight streams keep their captured (now-stale) instance until natural completion.
- **D59** (Oracle MAJOR): macOS install.sh prints `xattr -dr com.apple.quarantine ~/.local/bin/aio-proxy` recipe; npm meta-package shim prints multi-line diagnostic on platform mismatch.
- **D60** (Oracle MINOR): SQLite uses `journal_mode=WAL` + `busy_timeout` set at startup; all writes serialized through a single writer queue.
- **D61** (Momus blocker): every QA scenario writes evidence to the canonical `.omo/evidence/task-<N>-aio-proxy[-<variant>].<ext>` path.
- **D62** (Momus blocker): install host pre-decided as `https://raw.githubusercontent.com/<org>/aio-proxy/main/scripts/install.sh` (no custom domain in MVP); npm publish target `npmjs.org`; dist-tags `next` for prerelease, `latest` for stable.
- **D63** (Oracle MAJOR): e2e test fixtures partition into 3 sources (sanitized SDK recordings / handcrafted minimal / golden upstream-receive); final F1 mechanical grep forbids real api-key patterns in committed fixtures.

### Dependency / framework decisions added during dependency grilling (Q43-Q49 + Q47-DEP*)
- **D64**: Dashboard is pure SPA. Data flow = Hono RPC dashboard API + SSE only. SQLite is server-side only. Rules out TanStack DB.
- **D65**: Server-side ORM = drizzle-orm@0.45.2 + `drizzle-orm/bun-sqlite` + `bun:sqlite`. Migrations via drizzle-kit@0.31.10 (build-time only, NEVER runtime). TanStack DB rejected: (a) Node SQLite adapter uses `better-sqlite3` not `bun:sqlite`, (b) SQLite persistence stores TanStack DB internal collection format not arbitrary business tables, (c) cannot do arbitrary SQL aggregations like `GROUP BY model_alias, SUM(input_tokens)`.
- **D66**: Dashboard data layer = TanStack Query@5.101.2. NO TanStack DB. SSE invalidates relevant Query keys; trace list virtualized via TanStack Virtual.
- **D67**: CLI framework = commander@15.0.0 (ESM-only). Rejected alternatives: yargs (heavy + opencode shows it doesn't auto-i18n at the CLI level anyway), citty/cac (smaller ecosystem), clipanion (still RC).
- **D68**: i18n = `packages/i18n` typed-dict (en + zh-CN MVP; ja/ko Phase 2). Locale chain `--lang > AIO_PROXY_LANG > LC_ALL > LC_MESSAGES > LANG > LANGUAGE > Intl > "en"` (CLI), `localStorage > navigator.language > "en"` (dashboard). Shared dictionary across CLI + dashboard. NO i18next/Lingui. Pattern derived from openclaw `src/wizard/i18n/*` and `ui/src/i18n/*`. Errors mapped at boundaries via `formatUserError(err, locale)`.
- **D69**: Inter-process locks = `proper-lockfile@4.x` for `aio-proxy.db` open + config writes (in-process queue + cross-process file lock per openclaw `src/config/mutate.ts:58-67,198-205`); custom PID+starttime sidecar lock with stale recovery for npm cache install (per openclaw `src/agents/session-write-lock.ts:524-546,928-944`).
- **D70**: e2e split: dashboard e2e via `@playwright/test`; API/protocol e2e via `bun test` + hand-written `Bun.serve` mock upstream. NO msw.
- **D71**: Tailwind v4 + shadcn 4.12.0 + React 19. Dashboard initialized via user's pre-configured preset: `bunx --bun shadcn@latest init --preset b6a2WHJKc --template vite --pointer`. Todo 26's acceptance gate verifies this EXACT command was used.
- **D72**: `date-fns@^4.1.0` for time formatting.
- **D73**: Adds `packages/i18n` to monorepo (now 7 packages, was 6). Dependency layering: `types` ← `i18n` (types only) ← `core` ← `auth-flows` ← `server` ← `cli`; `dashboard` independently consumes `i18n` + `types`.
- **D74**: Forbidden dependencies (PR rejection list): TanStack DB, lodash, dayjs, moment, ramda, radash, i18next, lingui, formatjs, react-i18next, polyglot, yargs, oclif, citty, clipanion, cac, msw, chalk, picocolors, marked, DOMPurify, react-markdown.
- **D75**: Use **Turborepo** as the monorepo task orchestration layer while keeping Bun as runtime, package manager, workspace protocol, test runner, and binary compiler. Root scripts route package-level build/check/test/dev through `turbo run ...`; do NOT add root `scripts/check-*.ts` gates. Package scripts remain ordinary Bun commands. Reasons: (a) the repo is intentionally 7 packages from day one, so a task graph is useful immediately; (b) Turbo gives local/CI cache hits and explicit `outputs` for dashboard dist, binary dist, generated migrations, route tree, and paraglide output; (c) Turbo is officially compatible with Bun workspaces; (d) remote cache stays optional/off by default for MVP, documented as a Phase-2/CI-scale switch. Still forbidden: nx / lerna.

### v3 modifications after second-pass Oracle/Momus review (Q50 + ITEM1-5)
- **D76**: All file names use `kebab-case`. Exported names (React components, classes) remain PascalCase; variable/function names follow standard JS conventions. The TanStack Router file-based codegen output is configured to `src/route-tree.gen.ts` (NOT the default `routeTree.gen.ts`). Allowed exceptions: open-source convention files (README.md, LICENSE, CHANGELOG.md, etc.), third-party tool config files (package.json, tsconfig.json, vite.config.ts, drizzle.config.ts, biome.json, playwright.config.ts), dotfiles. Verified by F1 mechanical file-list audit, not by a custom check script.
- **D77**: i18n architecture switched from hand-rolled typed-dict to **paraglide-js** (`@inlang/paraglide-js`). Reasoning: (a) missing message keys are TS compile errors (no separate `i18n:check` script needed; the type system is the gate); (b) per-message tree-shaking shrinks both CLI binary and dashboard bundle; (c) typed param signatures from `messages/*.json` are real TS function signatures, not template-literal-type gymnastics; (d) zero-config Vite/Bun bundling. Layout: `packages/i18n/messages/{en,zh-CN}.json` (canonical) → paraglide compile → `packages/i18n/src/paraglide/*` (gitignored codegen). API: `import * as m from "@aio-proxy/i18n"` then `m.cli_serve_description()` / `m.error_provider_not_installed({ pkg })`. Key naming convention: `snake_case` with namespace prefix (`cli_*`, `error_*`, `wizard_*`, `dashboard_*`, `common_*`). MVP locales: en + zh-CN. Forbidden alternatives (D74 expanded): `i18next`, `@lingui/*`, `@formatjs/*`, `react-i18next`, `polyglot`, hand-rolled typed-dict (the previous baseline is now superseded).
- **D78** (B-O5 fix): Subscription provider tokens (Copilot today, ChatGPT/Cursor in Phase 2) MUST be written via a CAS helper `Auth.cas(vendor, providerId, expectedAccountFingerprint, mutator)` running inside a SQLite transaction. Direct `Auth.set` is forbidden inside `core/src/provider/subscription/*.ts`. Rationale: in-flight requests under generation N must not corrupt generation N+1's auth row when reload rotates the account/provider mid-flight.
- **D79** (B-O1 fix): drizzle migrations are baked into the binary via a generated `packages/core/src/db/migrations.manifest.ts` that statically imports each `.sql` via `with { type: "text" }`. Runtime applies them in order tracked by `PRAGMA user_version`. Build refuses to start if `user_version > COMPILED_SCHEMA_VERSION`. F1 re-runs `drizzle-kit generate` in a clean dir and asserts no diff, blocking schema-without-migration PRs without adding a custom check script.
- **D80** (B-O2 fix): `packages/core/src/db/open-db.ts` is the SINGLE allowed entry point for opening `aio-proxy.db`. F1 mechanical grep rejects any `new Database(` or `drizzle(` call outside this file. The function applies the canonical PRAGMA sequence (WAL → busy_timeout → foreign_keys → synchronous=NORMAL) BEFORE wrapping with drizzle, and acquires a process-singleton lock before any writes.
- **D81** (B-O4 fix): TanStack Router file-based routing requires `@tanstack/router-plugin` as a direct dev dep + Vite plugin (added to `## Dependencies`). The plugin is configured with `generatedRouteTree: "src/route-tree.gen.ts"` to satisfy D76 kebab-case. The codegen file is gitignored.
- **D82** (M-O7 fix): commander 15 ESM-only is verified by an early `bun build --compile` smoke in todo 4 (host-target binary, run `--version` / `--help` / `--lang zh-CN --help` / negative `--port 99999`). If commander 15 fails to bundle, todo 4 fails HARD and surfaces to user; do NOT silently downgrade.
- **D83** (M-O11 fix): root `package.json` exposes split test scripts (`test:unit`, `test:e2e:api`, `test:e2e:dashboard`, `test:all`); CI runs `test:all`; dashboard e2e runs in a separate CI job that builds dashboard + spawns a backgrounded `aio-proxy serve` against a fixture HOME, then `bunx playwright test`.
- **D84** (M-O14 fix): Bun workspace filter syntax, when used inside package/root helper scripts, is `bun run --filter '*' <script>` (not `bun --filter '*' run <script>`). Topological workspace execution is normally delegated to Turbo's task graph; direct Bun filter smoke is still verified in todo 1 so fallback package commands remain correct.
- **D85** (M-O8 fix): every `packages/*/tsconfig.json` has `"composite": true`, `"declaration": true`, `"declarationMap": true`. Cross-package consumers add `"references": [{ "path": "../<pkg>" }]`. `packages/i18n/package.json` exposes paraglide codegen via `"exports"` map.
- **D86** (Momus B-M3 / Oracle B-O3 fix): the shadcn preset `b6a2WHJKc` is run ONCE during todo 26's first commit; ALL resolved outputs (`components.json`, `src/index.css` with `@theme` blocks, `src/lib/utils.ts`, baseline shadcn components under `src/components/ui/`) are committed to the repo. From that point forward the LOCAL files are the source of truth; the preset id is recorded as provenance only. Acceptance verifies checked-in files exist, NOT remote preset availability.
- **D87** (Oracle 9 fix): release builds enforce binary size ≤ 150 MB hard cap, ≥ 140 MB warning. Todo 29 emits a per-target size report (binary total, embedded asset breakdown, top-20 largest assets, sourcemap presence).

### v4 fixes after third-pass review (Momus REJECT × 3, Oracle REVISE × 4 BLOCKING + 7 MAJOR)
- **D88** (B1 fix + user-supplied paraglide knowledge): `packages/i18n/src/index.ts` re-exports the aggregated `m` object via `export { m } from "./paraglide/messages"` (NOT `export *` or `export * as m`). Paraglide v2+ default output emits a single `m` object whose properties are typed message functions PLUS a sibling `messages.d.ts` declaration file. Consumers do `import { m } from "@aio-proxy/i18n"; m.cli_serve_description();` — clean, typed, tree-shakable.
- **D89** (B2 fix): all v3-residual `t("...")` legacy calls replaced with `m.*()` paraglide calls in todo 26 dashboard scaffold and elsewhere.
- **D90** (B3 fix): D76 file naming exception list explicitly allows TanStack Router framework conventions (`__root.tsx` and other double-underscore-prefixed route files), `components.json` (third-party tool name).
- **D91** (B4 fix): `auth` table gets a first-class `accountFingerprint` column (nullable on first insert; non-null thereafter). `Auth.cas()` runs in a `BEGIN IMMEDIATE` transaction with single-statement `INSERT ... ON CONFLICT DO UPDATE WHERE account_fingerprint = ?` — atomic CAS at the SQL level. Defined signature: `cas(vendor, providerId, expectedFingerprint: string|null, mutator): void` synchronous, throws `StaleProviderGenerationError` on mismatch.
- **D92** (B5 fix): root `build:binary` and `build:dashboard` scripts depend on `i18n:compile` first. `packages/cli/build.ts` runs prebuild assertions (i18n compiled, dashboard built, route-tree generated, migrations.manifest exists) before invoking `Bun.build`. Missing prebuild → fail with one-line hint.
- **D93** (M1 / Oracle 2 fix): server-side code (`packages/server/`) MUST use per-call locale override `m.foo({ ...args, locale })` and MUST NOT call `setLocale()` (which mutates module-level state and would race across concurrent requests). `formatUserError(err, locale)` is side-effect-free. CLI/dashboard's CLI-boot / browser-toggle `setLocale` is fine. Lint gate flags `setLocale(` calls inside `packages/server/src/**`.
- **D94** (M2 fix): shadcn provenance lives in `packages/dashboard/shadcn-provenance.md` (NOT inside `components.json`, which is strict JSON without comment support).
- **D95** (M3 fix): todo 26 acceptance does NOT require the remote shadcn preset id to be reproducible; only local files must exist. The "future shadcn add" smoke (`bunx shadcn@latest add accordion --dry-run`) verifies local baseline is sufficient without the preset id.
- **D96** (M4 fix): commander 15 binary smoke has a documented fallback ladder — first fall back to `commander@^14`, then `cac@^7`, recorded in `RELEASE.md`. Don't switch parser families without explicit user approval.
- **D97** (M5 / Oracle 10 fix): `build:dashboard` script chains `i18n:compile && build`. `build:binary` chains both. Same pipeline used in CI dashboard-e2e job.
- **D98** (M7 / Oracle 15 fix): `openDb({ home? })` accepts an explicit home path; resolution `opts.home > AIO_PROXY_HOME env > platform default`. Tests MUST pass `home: <tempDir>` so each test is isolated; parallel-test deadlock and developer-db clobbering avoided.
- **D99** (Oracle 4 fix): drizzle migrations use ONLY `with { type: "text" }`; if Bun version doesn't support it, BUILD FAILS — no `with { type: "file" }` fallback (would break "no runtime fs reads" promise).
- **D100** (Oracle 5 fix): runtime migration apply verifies each baked SQL's `sha256` against the manifest entry before exec — defense-in-depth against tampering / partial bundle corruption.

### v4→v5 internal-consistency corrections (Momus REJECT × 3, Oracle REVISE × 4 BLOCKING + 5 MAJOR)
- **D101** (Momus B1 fix): todo 22 Step 1 schema includes `accountFingerprint: text("account_fingerprint")` column matching the canonical schema in `## Database architecture`. Plan-internal contradiction resolved.
- **D102** (Momus B2 / Oracle 5 fix): `formatUserError(err, locale)` is side-effect-free per D93 — uses paraglide's per-call locale override `m.foo(args, { locale })` (locale as SECOND argument, NOT mixed into args). MUST NOT call `setLocale()`. F1 mechanical grep flags `setLocale(` calls inside `packages/server/src/**` AND `packages/i18n/src/format-error.ts`.
- **D103** (Momus B3 / Oracle 6 fix): all auth-flows tests use `AIO_PROXY_HOME=$(mktemp -d)` for isolation per D98. Acceptance commands stat `$AIO_PROXY_HOME/aio-proxy.db` (not the hardcoded default).
- **D104** (Oracle B3 fix): Bun `sqlite.transaction()` API is correctly used. The wrapper is called as `casTx.immediate()` (NOT `transaction(fn)("immediate")` which doesn't exist). The inner function does NOT receive a `tx` parameter — it uses the captured `sqlite` handle directly. Mutator MUST be SYNCHRONOUS — async mutators commit before the Promise resolves and break atomicity. Type signature enforces sync mutator.
- **D105** (Oracle B5 fix): paraglide v2 per-call locale API is `m.foo(args, { locale })` — locale is the SECOND positional argument, not part of args. For zero-arg messages: `m.error_internal_unexpected({}, { locale })`.
- **D106** (Oracle 1 fix — tree-shaking spike): todo 35 `_test/tree-shake-spike.test.ts` generates 100 spike messages, builds with only one used, asserts unused message strings are absent from output. If spike fails, planner must revisit per-message tree-shake claim of D77.
- **D107** (Oracle 6 fix — same-process registry): `openDb()` uses a process-level `Map<resolvedDbPath, { sqlite, db, refCount }>` registry. Re-opening same path returns same handles (refCount++). Avoids self-deadlock when server boot + test helper open same db. `close()` decrements refCount; physical close at 0.
- **D108** (Oracle 8 fix — paraglide --emitTsDeclarations): `packages/i18n/scripts/compile.ts` MUST pass `--emitTsDeclarations` flag. Without it, no `messages.d.ts` is generated and `tsc -b` fails on `import { m } from "@aio-proxy/i18n"`.
- **D109** (Oracle 10 fix — dashboard size): hard cap raised from 1.2 MB to 2.5 MB gzipped (React 19 + 5 TanStack packages + Tailwind v4 + shadcn baseline more realistic). 1.2 MB is now the warning threshold. Acceptance command actually computes gzipped size with `gzip -kn` + `stat`, not `du -sh` (which was the pre-gzip directory size).
- **D110** (Oracle 11 fix — Auth.cas sync): `Auth.cas()` is SYNCHRONOUS; mutator is also SYNCHRONOUS (returns a value, NOT a Promise). Callers must NOT `await Auth.cas(...)` — the call is sync. Type signature: `cas(...mutator: SyncMutator): void` — TypeScript rejects mutators that return `Promise<...>`.
- **D111** (Oracle 7 fix — migration error message): hash-mismatch throws `MigrationHashMismatchError` with explicit recovery hint mentioning the exact rebuild commands.
- **D112** (Oracle 9 fix — `check` self-contained): root `bun run check` script chains `i18n:compile` first so a fresh checkout running `bun run check` does not fail due to missing paraglide outputs.
- **D113** (Oracle 4 fix — prebuild error format): unified format `"Missing <path>. This script expects prebuild artifacts. Normally invoked via \`bun run build:binary\` ... To recover, run: <hint>."` with explicit hints per artifact.
- **D114** (user-driven, after v5 fixes): Use the root `package.json` `workspaces.catalog` ONLY for dependencies consumed by more than one workspace package or by both root scripts and a package. Single-package-only dependencies are declared locally in that package's `package.json` with their normal version range. Workspace-internal deps still use `"workspace:*"`. Pin policy: ai-sdk + `@openrouter/ai-sdk-provider` EXACT when cataloged or bundled into the binary; shared runtime/dashboard deps use `^`; dev-only e2e SDKs (`openai`, `@anthropic-ai/sdk`, `@google/genai`, `@playwright/test`) use `*` where declared. F1 validates that catalog entries are actually shared and that package-local deps are not needlessly hoisted into catalog; no custom root check script.
- **D116** (user-driven): Implementation must commit after every completed todo. A todo is complete only after its code changes, tests/QA, and `.omo/evidence/...` artifact are present; the worker must then immediately create exactly one conventional commit for that todo before starting the next todo. Do NOT batch multiple todos into one commit and do NOT leave completed todo work uncommitted.


## Scope IN
- 4 ingress protocols (OpenAI Chat / Responses / Anthropic / Gemini), passthrough + cross-protocol via ai-sdk.
- 3 provider kinds: `api` (openai-compatible / openai-response / claude / gemini), `subscription` (github-copilot), `ai-sdk` (8 bundled + runtime npm fallback).
- Hono server with `/dashboard/*` Hono RPC API + SSE.
- Vite+React+shadcn dashboard embedded in binary.
- SQLite traces (7-day TTL) + usage (forever).
- Init wizard, hot reload, OAuth device flow, alias collision detection, capability silent-drop.
- 5-platform binary matrix + npm meta package + curl|sh installer.

## Scope OUT (Must NOT have)
- ChatGPT subscription auth (Plus/Pro). Phase 2.
- Cursor / Claude-code OAuth flows. Phase 2.
- Token-based local auth, per-token usage attribution. Phase 2.
- Fallback chains, load-balance, retry-on-different-provider. Phase 2 (`routes` table).
- Strict capability-mismatch 400 rejection. Phase 2 (lenient mode flag).
- Chat playground in dashboard.
- Telemetry / phone-home.
- Homebrew, scoop, AUR. Phase 2.
- Tauri / Electron desktop app.
- Node.js runtime requirement on user machine; runtime requires only the shipped Bun-compiled binary.
- Vertex / Bedrock / Azure provider presets. Phase 2.
- OpenTelemetry exporter. Phase 2.
- Plugin SDK / external plugin loader. Provider extension limited to ai-sdk packages via npm fallback.

## Open questions
None at gate. All forks resolved through 114 explicit decisions (Q1–Q50 + ITEM1-3 + paraglide-js correction + v4 internal-consistency + shared-catalog policy).

**v4→v5 corrections** (Momus REJECT × 3, Oracle REVISE × 4 BLOCKING + 5 MAJOR — all internal-consistency, no new architecture):

Decisions added in v5: **D101** (todo 22 schema accountFingerprint, B1), **D102** (formatUserError side-effect-free + F1 setLocale grep, B2), **D103** (AIO_PROXY_HOME in tests, B3), **D104** (Bun transaction API correct usage, B4), **D105** (paraglide per-call locale = second arg, B5), **D106** (tree-shake spike test, M1), **D107** (openDb same-process registry, M2), **D108** (paraglide --emitTsDeclarations flag, M3), **D109** (dashboard 2.5 MB hard / 1.2 MB warn gzipped, M4), **D110** (Auth.cas sync, M5), **D111** (migration hash mismatch error msg, MINOR), **D112** (root `check` chains i18n:compile, MINOR), **D113** (unified prebuild error format, MINOR), **D114** (catalog only for shared dependencies + F1 package.json audit, user-driven).

All 4 review rounds' BLOCKING + MAJOR items addressed. The architecture has been stable across rounds 2-5; only internal-consistency cleanups remained in v4. v5 is the final iteration before approval gate.

## Approval gate
status: awaiting-approval
gate-record:
  - 41 decisions recorded above
  - Approach summarized in front-matter `approach`
  - Pending action: write detailed `.omo/plans/aio-proxy.md` with 8 milestones × ~5 todos each
  - User must say "approved" / "go" / "$start-work" to advance
  - Re-running scaffold-plan.mjs is a safe no-op (won't clobber appended todos)
