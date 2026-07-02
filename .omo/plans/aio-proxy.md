# aio-proxy - Work Plan

## TL;DR (For humans)

**What you'll get:** 一个本地运行的 AI 代理 CLI，把你电脑变成"人人可用的 AI 网关"——在配置里写一遍各家 provider（API key、订阅、ai-sdk 包），客户端工具（Cursor / Codex / Cline / Claude Desktop / aider）只把 base URL 指向 `http://127.0.0.1:22078` 就能用任意上游模型，并附带一个 `aio-proxy dashboard` 命令打开的网页用来管理 provider、看请求历史、查 token 用量。

**Why this approach:** 复用 Vercel AI SDK 7 作为内部统一表示（不重造轮子），同协议同家原生 endpoint 时直接字节透传（性能 + 不损语义），跨协议时让 ai-sdk 做转换（claude→openai 这种 12 条对角路径全部由 ai-sdk 一手包办）。Provider 扩展用"内置 8 个热门 ai-sdk + 用户机器运行时安装任意 npm 包"双轨，复制 opencode 的成熟方案。二进制用 Bun 一条命令跨编译 5 个平台。

**What it will NOT do:**
- 不做 ChatGPT 订阅鉴权（仅 Copilot 进 MVP，ChatGPT 留 Phase 2）
- 不做 fallback 链 / 负载均衡（Phase 2 加 `routes` 表）
- 不做 token / 用户鉴权 / 多租户（MVP 仅 127.0.0.1 不鉴权）
- 不做 chat 聊天界面（这是代理工具不是 chat 客户端）
- 不收集任何 telemetry

**Effort:** Large (6-8 weeks 全职等价)
**Risk:** Medium - 二进制跨平台 + 4 协议适配器 + 3 种 provider 类型有不少未踩过的坑，但每个都有现成参考实现可对照（opencode / litellm / claude-code-router / openclaw）。
**Decisions to sanity-check:** ① IR 押宝 ai-sdk@7（耦合换简单度，封装在 `core/ai-sdk-bridge`） ② 默认端口 22078/22079 ③ MVP 只接 Copilot 一种订阅 ④ trace 7 天 + usage 永久 ⑤ runtime npm install 默认 OFF（需 `aio-proxy provider install` 显式确认） ⑥ Bun-compiled binary 通过 `process.execPath + BUN_BE_BUN=1` 自旋 ⑦ 7 包 monorepo（含独立 `packages/i18n` 共享 CLI+dashboard） ⑧ drizzle-orm + bun:sqlite 服务端 ORM、TanStack Query dashboard ⑨ commander@15 + paraglide-js i18n（`import { m } from "@aio-proxy/i18n"` 聚合对象，缺 key TS 编译报错；commander 失败 fallback 到 14 → cac） ⑩ shadcn 用预配置 preset `b6a2WHJKc` 初始化、首次 init 后 baseline 入仓、provenance 进 `shadcn-provenance.md`（不在 components.json 注释）⑪ kebab-case 全局文件命名规约 + `__root.tsx` 等 framework 例外（D76/D90）⑫ Auth.cas 用 BEGIN IMMEDIATE + `account_fingerprint` 列做 SQL 级原子 CAS（B4/D104 fix）⑬ **workspace catalog 仅用于多包复用依赖**（D114；单包依赖就近声明版本，workspace 内部依赖用 `"workspace:*"`）⑭ **Turborepo 编排 + Bun runtime/package manager**（D75；remote cache MVP 默认关闭）⑮ **dashboard/control API 前缀用 `/dashboard/*`，通过 Hono RPC 暴露，不叫 `/admin/*`**（D115）⑯ NO TanStack DB / NO i18next / NO lodash（D74/D77 forbidden 清单）

Your next move: 说 `approved` / `开始` / `$start-work` 进入实现；或说"再调整 X"回到讨论。Full execution detail follows below.

---

> TL;DR (machine): Effort=Large(6-8w); Risk=Medium(cross-compile+4 protocol adapters); Deliverables=monorepo(7 pkgs, 6 publishable)+5-platform binaries+npm pkg+install.sh.

## Scope

### Must have
1. Bun monorepo, **7 packages**: `types` / `i18n` / `core` / `auth-flows` / `server` / `dashboard` / `cli`. The `i18n` package is shared by both `cli` and `dashboard` so a single dictionary update reflects in both surfaces.
2. 4 ingress protocols on a single Hono server: OpenAI Chat (`/v1/chat/completions`), OpenAI Responses (`/v1/responses`), Anthropic Messages (`/v1/messages`), Gemini (`/v1beta/models/:model::generateContent` + `:streamGenerateContent`).
3. 3 provider kinds: `api` (openai-compatible / claude / gemini wire), `subscription` (github-copilot device flow), `ai-sdk` (BUNDLED of 8 + opt-in runtime `npm.add` fallback to `~/.config/aio-proxy/cache/packages/<sanitize>/node_modules/`).
4. **Hybrid request strategy with explicit passthrough table**: `passthrough: boolean` is a derived per-(ingress, provider) flag computed at config-load time. It is `true` ONLY when ALL of: `ingress.protocol === provider.protocol`, `provider.kind === "api"`, AND `provider.vendor` is in the explicit allow-list `{"openai-native", "anthropic-native", "google-native"}`. Anything else (subscription, ai-sdk, openai-compatible 3rd-party, Azure, anything not in the allow-list) → ai-sdk transformation path. The flag is exposed via Hono RPC route `GET /dashboard/providers/:id` for debuggability.
5. Hot reload of `~/.config/aio-proxy/config.jsonc` via Bun.watch + `/dashboard/reload` with **a 4-stage pipeline** (parse zod → build provider instances → build router/alias table → run alias-collision check) where ANY failure keeps the OLD config serving requests.
6. SQLite at `~/.config/aio-proxy/aio-proxy.db` (NOT scoped to traces — same DB hosts `traces`, `usage`, `auth`, `models_dev_cache`, future `config_snapshots`) with: `traces` (7-day TTL, body redacted via header denylist + JSON key denylist + URL query denylist + 256KB cap per body, configurable via `trace.bodyMode: "redacted"|"off"|"full"` defaulting to `"redacted"`) + `usage` (forever, aggregate; `PRAGMA user_version` based forward-only migrations). All schema access through **drizzle-orm + `drizzle-orm/bun-sqlite`**. Migrations generated at build time by **drizzle-kit** as SQL files baked into the binary; runtime applies them by tracking `PRAGMA user_version`.
7. SSE endpoint `/dashboard/events` streaming `trace.start` / `trace.delta` / `trace.end` / `config.changed` with **bounded per-connection queue** (1000 events / 5MB; on overflow emit `events.dropped` and disconnect slow client).
8. Vite + React 19 + Tailwind v4 + shadcn/ui dashboard (initialized with `bunx --bun shadcn@latest init --preset b6a2WHJKc --template vite --pointer` — user's pre-configured theme preset, MUST be used in todo 26) embedded as `with { type: "file" }` assets, served on port 22079. Dashboard data flow is Hono RPC dashboard API + SSE only (D64); SQLite is server-side only (NO browser SQLite, NO TanStack DB).
9. CLI: `serve / dashboard / provider list|login|logout|install|test / model list / trace prune / --version`. CLI uses **commander@15** (ESM-only) plus `packages/i18n` paraglide message functions so help text + error messages localize.
10. First-run interactive init wizard with **atomic write semantics** (in-memory accumulation → tmp file → `rename`; SIGINT removes tmp; never echoes secret).
11. 5-platform binary (`bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64-modern`, `bun-linux-arm64`, `bun-windows-x64`) via `bun build --compile`.
12. NPM publish: `aio-proxy-ai` meta package + `aio-proxy-<platform>` sub-packages as optionalDependencies. Meta-package `bin` shim resolves the right sub-package and prints actionable diagnostics on failure (`--no-optional`, wrong arch, `npm install --include=optional`, GitHub Release fallback URL).
13. `curl https://<install-host>/install.sh | sh` installer (host pre-decided in todo 31). On macOS prints `xattr -dr com.apple.quarantine ~/.local/bin/aio-proxy` instruction.
14. Three-layer test suite (unit / integration / e2e) + Biome lint + tsc strict in CI; **e2e MUST be HTTP-level mock upstream** (Bun.serve fake) and assert raw upstream request body/headers + downstream SDK-consumed events. Dashboard e2e uses **@playwright/test**; API e2e uses **bun test** with a hand-written `Bun.serve` mock upstream — NO msw.
15. MIT license.
16. **Provider-specific field carriage contract** (the IR Fitness Table — see new section below). Every adapter's golden tests assert this table.
17. **Single-flight token refresh** for subscription providers (`Map<providerId, Promise<Token>>`); concurrent expirations coalesce to one refresh.
18. **i18n unified across CLI + dashboard** via `packages/i18n` powered by **paraglide-js** (D77, replacing the earlier ad hoc dictionary idea). Compile-time codegen turns `messages/*.json` into per-message TypeScript functions; missing keys are TS compile errors (no separate `i18n:check` lint script needed); per-message tree-shaking shrinks both binary and dashboard bundle. MVP locales: en + zh-CN (ja/ko Phase 2). Locale resolution chain — CLI: `--lang > AIO_PROXY_LANG > LC_ALL > LC_MESSAGES > LANG > LANGUAGE > Intl > "en"`; dashboard: `localStorage > navigator.language > "en"`. NO i18next, NO Lingui, NO react-i18next, NO formatjs (D74).
19. **Inter-process locks** for: `aio-proxy.db` open (singleton-server-instance check), config writes via `proper-lockfile` (in-process queue + cross-process file lock, openclaw pattern), npm cache install via custom PID+starttime sidecar lock with stale recovery.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- ChatGPT subscription / Cursor-pro / Claude-code OAuth (Phase 2).
- Token-based local API auth, per-token usage attribution, multi-tenant.
- Fallback chains, load-balance, retry-on-different-provider, OpenRouter-style "route" entities.
- Strict capability-mismatch rejection (silent drop only) **EXCEPT** stateful continuation (`previous_response_id` in OpenAI Responses), which MUST be rejected with 501 — NOT silently dropped.
- Chat playground / completion testing UI in dashboard.
- Telemetry collection (zero phone-home).
- Homebrew tap / scoop / AUR / nix.
- Tauri / Electron desktop wrapper.
- Vertex / Bedrock / Azure / SAP AI Core provider presets. **Azure OpenAI specifically**: it is not in the passthrough allow-list (different path/header/body contract); MVP rejects Azure config with a clear "use ai-sdk kind with @ai-sdk/azure or wait for Phase 2 preset" error.
- OpenTelemetry / Prometheus exporters.
- Plugin SDK or external plugin loader (extension is via the ai-sdk npm fallback only).
- Node.js runtime as a user-facing requirement (binary is fully self-contained).
- A custom neutral IR — we explicitly use ai-sdk's `LanguageModelV2/V3` + `ModelMessage` and accept ai-sdk version coupling.
- Fancy stream conversion library — leave that to ai-sdk's `streamText`.
- **Auto-installing arbitrary npm packages on `serve` startup**. Runtime `npm.add` fires ONLY when the user explicitly runs `aio-proxy provider install <pkg>` or clicks "Install" in the dashboard provider form. `serve` with a config referencing a not-yet-installed package fails fast with an actionable error.
- **Re-exporting ai-sdk runtime types from `packages/types`**. The public `@aio-proxy/types` ABI must be ai-sdk-version-agnostic; only schema and our own type aliases are exported. ai-sdk type usage is contained inside `packages/core/src/ai-sdk-bridge/*` only.
- **Spawning a `bun` from user PATH**. All runtime npm installs use `Bun.spawn([process.execPath, "add", pkg, "--no-save"], { env: { ...process.env, BUN_BE_BUN: "1" }, cwd: cacheDir })` so it works regardless of whether the user has bun installed system-wide.
- Models.dev as a routing or capability-decision input. It is **decoration only** (autocomplete, defaults, dashboard hints). Unknown model ids never trigger 4xx; capability flags from models.dev never gate passthrough/transform.
- Mutating provider instances after construction. Provider instances are immutable after `createProvider(config)` returns; reload always builds new instances and atomically swaps the map. In-flight streams keep using their captured (now-stale) provider until they finish naturally.

### Dashboard/control API contract (D115)

OpenClaw uses "Control UI" for this surface and avoids calling local operator routes "admin"; aio-proxy follows that direction. The local dashboard/control API prefix is `/dashboard/*`, not `/admin/*`, and it is exposed through Hono RPC. Server route modules are composed with chained `.route()` calls, the composed app exports `type AppType = typeof routes`, and dashboard code constructs clients with `hc<AppType>()`. The only dashboard exception is SSE: `/dashboard/events` may use `EventSource` directly because Hono RPC's typed client does not replace browser SSE streaming semantics.

## Dependencies (shared catalog only, D114)

> The root `package.json` `workspaces.catalog` field is used ONLY for dependencies that are consumed by more than one workspace package, or by both a root script and at least one package. Single-package-only dependencies are declared locally in that package's own `dependencies` / `devDependencies` with their normal version range. The catalog is a version table, not an installer; any package that actually uses a cataloged dep still declares it with `"catalog:"`.
>
> **Root-only tools do not go into the catalog unless also shared.** A tool used only by root scripts is declared in root `devDependencies` with its version there. A tool used by root scripts and packages can be cataloged and declared as `"catalog:"` in each consumer. Do not rely on bare `bunx drizzle-kit` or any other latest-from-network root script when reproducibility matters.
>
> Version-pin policy:
> - **`ai` and every `@ai-sdk/*` and `@openrouter/ai-sdk-provider`** use **EXACT** versions (no `^`/`~`) — they're bundled into the binary and we want zero surprise drift.
> - Everything else uses `^` (accept patch + minor) unless explicitly noted.
> - Dev-only e2e SDKs (`openai`, `@anthropic-ai/sdk`, `@google/genai`, `@playwright/test`) use `*` (always-latest) — they're not shipped, only used to verify ingress shape against current upstream behavior.

Root `package.json` shared catalog (exact membership is finalized in todo 1 after package manifests are written):

```jsonc
{
  "name": "aio-proxy",
  "private": true,
  "packageManager": "bun@1.3.14",
  "workspaces": {
    "packages": ["packages/*"],
    "catalog": {
      // BUNDLED ai-sdk — shared by core bridge, provider tests, and binary/release verification; EXACT pins
      "ai": "<exact>",
      "@ai-sdk/openai": "<exact>",
      "@ai-sdk/anthropic": "<exact>",
      "@ai-sdk/google": "<exact>",
      "@ai-sdk/openai-compatible": "<exact>",
      "@ai-sdk/mistral": "<exact>",
      "@ai-sdk/groq": "<exact>",
      "@ai-sdk/xai": "<exact>",
      "@openrouter/ai-sdk-provider": "<exact>",

      // Shared runtime/tool deps only
      "zod": "^4.4.3",
      "hono": "^4.10.0",
      "drizzle-orm": "^0.45.2",
      "es-toolkit": "^1.49.0",
      "proper-lockfile": "^4.1.2",
      "date-fns": "^4.1.0",

      // Shared dev tools
      "typescript": "^5.7.0"
    }
  },
  "devDependencies": {
    "@biomejs/biome": "^2.5.1",
    "drizzle-kit": "^0.31.10",
    "typescript": "catalog:",
    "turbo": "^2.9.6"
  }
}
```

Per-package `package.json` references (illustration — `packages/cli`):

```jsonc
{
  "name": "@aio-proxy/cli",
  "type": "module",
  "dependencies": {
    "commander": "^15.0.0",
    "@inquirer/prompts": "^8.5.2",
    "@aio-proxy/i18n": "workspace:*",
    "@aio-proxy/server": "workspace:*",
    "@aio-proxy/core": "workspace:*"
  }
}
```

Each package only declares the deps it actually uses. If a dep is shared and present in the catalog, use `"catalog:"`; if a dep is local to one package, declare the version in that package. Workspace-internal deps use `workspace:*`.

### Dependency placement

| package | role | placement |
|---|---|---|
| **BUNDLED ai-sdk** | | |
| ai | ai-sdk core (streamText, ModelMessage types) | catalog, exact |
| @ai-sdk/openai / anthropic / google / openai-compatible / mistral / groq / xai / @openrouter/ai-sdk-provider | bundled provider implementations | catalog, exact |
| **Runtime (CLI + server + auth-flows + core + i18n)** | | |
| commander | CLI parser (ESM-only) | local to `packages/cli` |
| zod | schema validation (config, IR, trace events) | catalog if used by multiple packages |
| hono | HTTP server + typed RPC client (`hono/client`) | catalog, shared by `packages/server` and `packages/dashboard`; versions MUST match |
| drizzle-orm | SQLite ORM (`drizzle-orm/bun-sqlite`) | catalog if used by core + auth-flows |
| es-toolkit | utilities (lodash replacement) | catalog only if used by multiple packages |
| @inquirer/prompts | wizard prompts (handle `ExitPromptError`) | local to `packages/cli` |
| proper-lockfile | inter-process file locks (auth/config/db open) | catalog if shared by core/auth-flows |
| date-fns | time formatting | catalog only if shared by CLI/dashboard/server |
| @inlang/paraglide-js | i18n compile-time codegen (D77) | local to `packages/i18n` unless another package invokes it directly |
| **Dashboard** | | |
| react / react-dom | UI | local to `packages/dashboard` unless another package renders React |
| vite / @vitejs/plugin-react | build | local to `packages/dashboard` |
| tailwindcss / @tailwindcss/vite | styles (v4 — different toolchain from v3) | local to `packages/dashboard` |
| lucide-react / class-variance-authority / clsx / tailwind-merge | shadcn ecosystem helpers + icons | local to `packages/dashboard` unless shared UI package exists |
| @tanstack/react-router | routing | local to `packages/dashboard` |
| @tanstack/router-plugin | **REQUIRED for file-based routing codegen** (`route-tree.gen.ts`, kebab-case per D76) — Vite plugin | local to `packages/dashboard` |
| @tanstack/react-query | server-state cache | local to `packages/dashboard` |
| @tanstack/react-table | trace + usage tables | local to `packages/dashboard` |
| @tanstack/react-form | provider/config forms | local to `packages/dashboard` |
| @tanstack/react-virtual | virtualized trace list | local to `packages/dashboard` |
| **Test / dev** | | |
| @biomejs/biome | format/lint/assist | root devDependency unless package scripts invoke it |
| drizzle-kit | migrations CLI (BUILD-TIME ONLY; never bundled) | root devDependency unless package scripts invoke it |
| @playwright/test | dashboard e2e | local to dashboard e2e or root CI, `*` |
| openai / @anthropic-ai/sdk / @google/genai | e2e ingress clients (verify wire shape against upstream) | local to e2e package/test owner, `*` |
| typescript | tsc | catalog if package manifests/scripts consume it; otherwise root devDependency |

`shadcn/ui` is added via the user's preset: `bunx --bun shadcn@latest init --preset b6a2WHJKc --template vite --pointer` — todo 26's acceptance gate verifies the LOCAL baseline files (D86), NOT the remote preset id (D95). Shadcn itself doesn't enter the catalog because component code is copied into the repo, not installed as an npm dep.

### Forbidden
The following are explicitly NOT used and any PR adding them must justify in the PR description:
- TanStack DB / @tanstack/db (D65/D66 — drizzle is the canonical store; dashboard uses TanStack Query only)
- lodash, dayjs, moment, ramda, radash (es-toolkit + date-fns + plain `as const` cover the surface)
- i18next, lingui, formatjs, react-i18next, polyglot (D77 — paraglide-js only)
- @inlang/sdk-js, direct `@inlang/sdk` runtime usage unless a later plan section explicitly justifies it, `@inlang/paraglide-js-react` unless we intentionally add rich-text helpers, and any hand-rolled runtime message dictionary once paraglide is in place
- yargs, oclif, citty, clipanion, cac (D67 — commander only)
- msw (D70 — hand-written `Bun.serve` mock upstreams)
- chalk, picocolors (use raw ANSI / `Bun.color` if needed)
- marked, DOMPurify, react-markdown (trace bodies render as `<pre>` until proven otherwise)
- TanStack DB Node SQLite persistence (D65 — uses better-sqlite3, conflicts with bun:sqlite + drizzle layer)
- **nx / lerna** (D75 — Turborepo is the chosen task orchestrator; do not add a second monorepo orchestrator)

## Monorepo task orchestration

Turborepo is the package-level build/check/test orchestration layer (D75). Bun remains the runtime, package manager, workspace protocol, test runner, and binary compiler. Root `package.json` scripts route package-level orchestration through `turbo run ...`. Do NOT create root `scripts/check-*.ts` gates; architectural constraints are covered by tests plus the final F1 mechanical audit. Package-level scripts are still ordinary Bun commands. Remote cache is documented but OFF by default for MVP.

```jsonc
{
  "scripts": {
    "check": "turbo run check",
    "lint": "biome check --write .",

    "test:unit": "turbo run test:unit",
    "test:e2e:api": "turbo run test:e2e --filter=@aio-proxy/server --filter=@aio-proxy/cli",
    "test:e2e:dashboard": "turbo run test:e2e --filter=@aio-proxy/dashboard",
    "test:all": "bun run test:unit && bun run test:e2e:api && bun run test:e2e:dashboard",
    "test": "bun run test:all",

    "build:migrations": "bun drizzle-kit generate --config=drizzle.config.ts",
    "build": "turbo run build",
    "build:dashboard": "turbo run build --filter=@aio-proxy/dashboard",
    "build:binary": "bun run i18n:compile && bun run build:dashboard && bun packages/cli/build.ts",

    "i18n:compile": "bun --filter '@aio-proxy/i18n' run compile",
    "dev": "turbo run dev --filter=@aio-proxy/cli",

    "preflight": "bun run i18n:compile && turbo run check test:unit"
  }
}
```

Root `turbo.json` is created in todo 1 and is the source of truth for task dependencies and cached outputs:

```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "compile": {
      "inputs": ["messages/**/*.json", "project.inlang/**", "scripts/compile.ts"],
      "outputs": ["src/paraglide/**"]
    },
    "build": {
      "dependsOn": ["^build", "compile"],
      "inputs": ["src/**", "package.json", "tsconfig.json"],
      "outputs": ["dist/**", "src/route-tree.gen.ts", "src/paraglide/**", "src/db/migrations.manifest.ts"]
    },
    "check": {
      "dependsOn": ["^build", "compile"],
      "outputs": []
    },
    "test:unit": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "test:e2e": {
      "dependsOn": ["build"],
      "cache": false,
      "outputs": []
    },
    "dev": {
      "persistent": true,
      "cache": false
    }
  }
}
```

`drizzle.config.ts` lives at the repo ROOT (single source of truth, accessible to both `build:migrations` and any IDE tooling):

```ts
// drizzle.config.ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/core/src/db/schema/**/*.ts",
  out: "./packages/core/src/db/migrations",
  strict: true,
});
```

TypeScript incremental builds via project references in each `tsconfig.json` (`composite: true` on every package; root `tsconfig.json` has `references: [...all 7 packages]`). Biome runs single-process parallel (Rust). Turbo caches package-level task results locally and in CI. Remote cache is optional and disabled unless a later release explicitly configures `TURBO_TOKEN` / `TURBO_TEAM`.

CI calls `bun run preflight && bun run test:all`. Dashboard e2e step launches `bun run build:dashboard && bun run --filter '@aio-proxy/cli' start &` then `bunx playwright test`.


## File naming convention (D76)

**All file names use `kebab-case`**. There is no PascalCase / camelCase file name in the repo.

- TypeScript / TSX source: `provider-form.tsx`, `trace-list.tsx`, `auth-flows.ts`, `open-db.ts`.
- React component files use kebab-case file names; the **exported** component names remain PascalCase: `provider-form.tsx` exports `ProviderForm`. Imports look like `import { ProviderForm } from "./provider-form"`.
- Tests: `provider-form.test.tsx`, `auth-store.test.ts`.
- Helper scripts are allowed only when they produce build artifacts or developer workflow output, not as root `check-*` gates. Example: `packages/core/scripts/build-migrations-manifest.ts`.
- Generated files: `route-tree.gen.ts`, `migrations.manifest.ts`. Configure TanStack Router plugin with `generatedRouteTree: "src/route-tree.gen.ts"` (NOT the default `routeTree.gen.ts`).
- SQL migrations: drizzle-kit's default `0000_xxx.sql` is already kebab-friendly; keep as-is.
- Allowed regex for any file under `packages/*/src/**`, `scripts/**`, `tests/**`: `^[a-z0-9][a-z0-9.-]*\.(ts|tsx|sql|json|md|css|html|svg)$`.

**Allowed exceptions**:
- `README.md`, `LICENSE`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md` (open-source convention; uppercase + extensions in `.md`).
- `package.json`, `bun.lock`, `tsconfig.json`, `biome.json`, `drizzle.config.ts`, `vite.config.ts`, `playwright.config.ts`, `components.json` (third-party tool conventions).
- `.gitignore`, `.gitattributes`, `.editorconfig`, dotfiles in general.
- **TanStack Router framework conventions**: `__root.tsx` (the layout-root file in file-based routing); double-underscore-prefixed route files in `packages/dashboard/src/routes/` are explicitly allowed by D76. Codegen output `route-tree.gen.ts` is already gitignored, but if it ever leaks into the repo it's also allowed.
- **Locale/tool generated files**: BCP-47 locale message files such as `packages/i18n/messages/zh-CN.json` are allowed despite uppercase region subtags. `packages/*/project.inlang/cache/**` and `packages/*/project.inlang/.meta.json` are generated/tool metadata and ignored by the filename checker.
- Auto-generated framework files where the framework hardcodes the name (none other expected; if encountered, declare in this list).

**Verification**: no custom filename check script in MVP. F1 runs a mechanical file-list audit against the regex + allowlist above and records any violation with a suggested kebab name.

## i18n architecture (paraglide-js, D77)

### Library choice
**[Paraglide JS](https://inlang.com/m/gerre34r/library-inlang-paraglideJs)** (`@inlang/paraglide-js`, MIT). Compile-time i18n: each message becomes a typed TypeScript function and missing keys are TS compile errors (no separate `i18n:check` script needed). Empirical task-35 spike on Bun 1.3.14 shows the aggregated `m` namespace does **not** tree-shake unused message names; MVP accepts the small static message-table size and keeps the bundle-size gate as the real guardrail. Phase 2 can switch hot paths to direct per-message imports if binary/dashboard size pressure appears.

Rationale (vs a hand-rolled runtime dictionary): (a) compile errors on missing keys are free via TS, replacing a custom lint script; (b) generated message functions have real TypeScript param signatures, not template-literal-type gymnastics; (c) inlang ecosystem (Sherlock VSCode extension, Lix, machine translation tooling) is opt-in and free; (d) the aggregated `m` namespace keeps call sites ergonomic, while size risk is controlled by dashboard/binary size checks rather than an unproven tree-shaking assumption.

### Layout
```
packages/i18n/
├── messages/
│   ├── en.json                    // canonical source — the authoritative dictionary
│   └── zh-CN.json                 // partial; missing keys fall back to en at compile time
├── project.inlang/
│   └── settings.json              // { "baseLocale": "en", "locales": ["en", "zh-CN"] }
├── src/
│   ├── paraglide/                 // codegen output — gitignored, regenerated by `compile`
│   │   ├── messages.js            // re-exports every message function
│   │   ├── runtime.js             // tiny runtime (locale getter/setter)
│   │   └── messages/
│   │       ├── en.js
│   │       └── zh-CN.js
│   ├── resolve.ts                 // resolveLocale(env?) → "en" | "zh-CN"; sets paraglide runtime locale
│   ├── format-error.ts            // formatUserError(err, locale) → { code, message } via paraglide
│   └── index.ts                   // re-exports paraglide messages + helpers
├── scripts/
│   └── compile.ts                 // wraps `bunx @inlang/paraglide-js compile --project project.inlang --outdir src/paraglide`
└── package.json
```

`src/paraglide/` is gitignored (codegen). `bun --filter '@aio-proxy/i18n' run compile` runs paraglide-js and is part of `preflight`. CI runs `compile` BEFORE `tsc -b`.

### Locale resolution chain (CLI, in order, first non-empty wins)
1. `--lang <locale>` CLI flag (CLI only)
2. `AIO_PROXY_LANG` env
3. `LC_ALL`
4. `LC_MESSAGES`
5. `LANG`
6. `LANGUAGE`
7. `Intl.DateTimeFormat().resolvedOptions().locale`
8. `"en"` (final default)

In dashboard, replace steps 1-6 with: `localStorage["aio-proxy.locale"]` > `navigator.language` > `"en"`.

`resolveLocale()` returns `"en" | "zh-CN"` (both available in MVP; ja/ko added in Phase 2 by extending the project.inlang `locales` array). Returned value is passed to paraglide's `setLocale()` runtime helper.

### Key naming
Paraglide message keys must be valid JavaScript identifiers. Use **`snake_case`** with scope prefix:
- `cli_serve_description`, `cli_error_port_out_of_range`
- `wizard_confirm_install_risk`, `wizard_provider_select_prompt`
- `error_provider_not_installed`, `error_config_invalid`, `error_alias_collision`
- `dashboard_providers_add_title`, `dashboard_providers_add_description`
- `common_cancel`, `common_confirm`, `common_loading`

The `error_*` namespace is shared between CLI exit messages and dashboard toast messages (single source of truth).

### Message format (en.json)
```json
{
  "cli_serve_description": "Start the aio-proxy server",
  "cli_error_port_out_of_range": "Port {port} is out of range (1-65535)",
  "error_provider_not_installed": "Provider package not installed: {pkg}. Run `aio-proxy provider install {pkg}` first."
}
```

Paraglide compiles each into a typed function: `m.error_provider_not_installed({ pkg: string }): string`. Missing the `{pkg}` argument fails TS compile. Calling `m.nope_not_a_key()` fails TS compile (function does not exist).

### Where translations get used
- **CLI**: command descriptions are message function calls — `program.description(m.cli_serve_description())`. Errors go through `formatUserError(err, locale)` from `@aio-proxy/i18n`.
- **Server**: ingress error envelopes are NOT translated (HTTP consumers expect English-stable codes). Dashboard/control API may translate based on `Accept-Language` in Phase 2.
- **Dashboard**: every shadcn component label, form error, toast — direct call `<Button>{m.common_confirm()}</Button>`.

### Bundling
- **CLI binary** (`bun build --compile`): paraglide compiles `messages/*.json` to ESM functions; Bun bundles them into the binary. Only message functions actually called are kept after tree-shaking.
- **Dashboard SPA** (Vite): paraglide-js ships a Vite plugin or its compiler can be invoked via `bun run` script before `vite build`. Each locale becomes a separate chunk; Vite tree-shakes per import. With only en + zh-CN both bundled, gzipped overhead is ≤30 KB; when ja/ko land we switch to dynamic imports per locale.

### Locale resolution timing (M-O12 fix)
Same problem as before — paraglide message functions read the runtime locale at CALL time, not at command-tree-build time. So the CLI must:
```ts
import { m, setLocale, resolveLocaleFromArgv } from "@aio-proxy/i18n";

setLocale(resolveLocaleFromArgv(process.argv));   // BEFORE program build
const program = buildProgram();
program.parse(process.argv);
```

Inside `buildProgram()` calls like `program.description(m.cli_serve_description())` happen AFTER `setLocale`, so they pick up the resolved locale. Snapshot tests in todo 4 verify `aio-proxy --lang zh-CN --help`, `LANG=zh_CN.UTF-8 aio-proxy --help`, and `aio-proxy --help` produce different localized outputs.

### Server-side per-request locale (M-O1 / Oracle 2 fix)

`setLocale()` mutates a module-level state. That's safe in a CLI process (single user, single locale per invocation) and in a browser (one user). It is **NOT** safe in a long-running server process where concurrent requests may want different locales.

**Rule**: in server / dashboard code (`packages/server/`, anywhere Hono is the runtime):
- DO NOT call `setLocale()`. The server-process default locale is whatever it was at CLI boot — typically `en` for the daemon.
- DO use the per-call locale option: every paraglide message function accepts an optional second argument `{ locale: Locale }` to override per call.
- `formatUserError(err, locale)` is **side-effect-free** — it does NOT call `setLocale`; it threads the locale via paraglide's per-call locale override (the canonical paraglide v2 API): `m.foo(args, { locale })` — locale is the **second** argument to the message function, NOT mixed into the first args object. For zero-arg messages, the call is `m.error_internal_unexpected({}, { locale })` (paraglide expects an empty args object as the first positional arg even when the message has no params).
- For dashboard Hono RPC API responses (Phase 2 — MVP returns English-stable codes), an `Accept-Language` parser maps the header to a `Locale`, and that value is passed explicitly to `formatUserError(err, locale)`.

For the CLI, the global `setLocale()` at boot is fine (single locale for the lifetime of that process invocation). For the dashboard, `setLocale()` on user toggle is fine (one user per browser tab). The server is the only caller of `formatUserError(err, locale)` with a per-request locale.

Verification: no custom lint script in MVP. F1 mechanically greps for `setLocale(` inside `packages/server/src/**` and `packages/i18n/src/format-error.ts`; the allowlist contains zero entries today.

### Cross-package type safety (M-O8 fix)
`packages/i18n/package.json`:
```jsonc
{
  "name": "@aio-proxy/i18n",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./runtime": "./src/paraglide/runtime.js",
    "./messages": "./src/paraglide/messages.js"
  }
}
```
With `tsconfig.json` `"composite": true`, `"declaration": true`, `"declarationMap": true`. Both `packages/cli/tsconfig.json` and `packages/dashboard/tsconfig.json` add `"references": [{ "path": "../i18n" }]` so `tsc -b` compiles i18n FIRST. Vite resolves the workspace via Bun's `package.json` workspaces — verified in todo 26's acceptance.

### Dashboard shadcn i18n enforcement (M-O9 fix, NO wrapper)
Direct `m.*()` calls inside shadcn components. NO `<I18nButton>` / `<I18nDialog>` wrapper twins. Pattern:

```tsx
import { m } from "@aio-proxy/i18n";

<Dialog>
  <DialogHeader>
    <DialogTitle>{m.dashboard_providers_add_title()}</DialogTitle>
    <DialogDescription>{m.dashboard_providers_add_description()}</DialogDescription>
  </DialogHeader>
  <DialogFooter>
    <Button variant="ghost">{m.common_cancel()}</Button>
    <Button>{m.common_confirm()}</Button>
  </DialogFooter>
</Dialog>
```

Enforcement is by code review plus F1 mechanical audit, not by a custom check script. F1 samples changed `packages/dashboard/src/**/*.tsx` and greps for obvious English JSX text/string-literal labels matching `/[A-Za-z]{2,}/`; any hit must be either routed through `m.*()` or recorded as an allowlisted brand/protocol string. Allowed exceptions:
- files in `packages/dashboard/src/i18n.ts`, `packages/dashboard/src/locales/`
- `*.test.tsx` / `*.test.ts`
- `packages/dashboard/src/route-tree.gen.ts` (generated)
- inline allowlist `/* i18n-allow: <reason> */` on the offending line (rare; brand strings only)

The script outputs offending file:line + suggested key. CI fails on any non-exempt match.

### Translation workflow
- Add a key to `messages/en.json` (canonical).
- Run `bun --filter '@aio-proxy/i18n' run compile` → paraglide regenerates `src/paraglide/`. TS breaks every consumer that calls `m.new_key()` if param shape is wrong; calling a missing key is also a compile error (function doesn't exist).
- Add the same key to `messages/zh-CN.json` (or omit; paraglide falls back to base locale at compile time, marking the key as `Missing` in inlang reports).
- Phase 1.5: optional `bun packages/i18n/scripts/sync-keys.ts` script copies missing keys from `en.json` to `zh-CN.json` as `"TODO: <english value>"` markers, similar to openclaw's `scripts/control-ui-i18n.ts` pattern.
- Phase 2: optionally LLM-assisted translation; or use Sherlock VSCode extension for in-editor translation.


## Database architecture (single-entrypoint + binary-baked migrations)

### `openDb()` is the ONLY way to open `aio-proxy.db`

`packages/core/src/db/open-db.ts` exports:
```ts
export function openDb(opts?: { readonly?: boolean; home?: string }): {
  sqlite: import("bun:sqlite").Database;
  db: import("drizzle-orm/bun-sqlite").BunSQLiteDatabase<typeof schema>;
};
```

The `home` option overrides the default config-home (`~/.config/aio-proxy/` on POSIX, `%APPDATA%\aio-proxy\` on Windows). Resolution order: `opts.home` > `AIO_PROXY_HOME` env > platform default. **Tests MUST pass an explicit `home: <tempDir>`** (or set `AIO_PROXY_HOME=<tempDir>` in the test setup) so each test has its own isolated db file and process-singleton lock — preventing parallel-test deadlock and clobbering of a developer's real local database (M-O15 / Oracle 15 fix).

**Same-process reentrancy** (Oracle v4 #6 fix): `openDb()` maintains a process-level registry `Map<resolvedDbPath, { sqlite, db, refCount }>`. A second call to `openDb()` with the same resolved path returns the SAME `{ sqlite, db }` handles (refCount incremented). The proper-lockfile process-singleton lock is acquired only on the first call per path. Callers should treat the returned handles as borrowed — `close()` decrements refCount and only physically closes when refCount reaches 0. This avoids self-deadlock when, e.g., `serve` boots the db and a test helper later calls `openDb()` for the same home path.

F1 mechanical audit: `grep -rE 'new Database\(|drizzle\(' packages/{core,server,cli,dashboard,auth-flows,i18n,types}/src` MUST return zero matches OUTSIDE `packages/core/src/db/`. Only `open-db.ts` may construct `Database` / call `drizzle()`.

### Open sequence (deterministic, locked)
1. `mkdir -p ~/.config/aio-proxy/` mode `0700` (Windows: `%APPDATA%\aio-proxy\`).
2. If `aio-proxy.db` doesn't exist: pre-create empty file with mode `0600` (POSIX `fs.openSync(path, "w", 0o600)` then close); on Windows skip (NTFS ACL handled by parent dir).
3. Acquire process-wide singleton lock at `aio-proxy.db.processlock` via `proper-lockfile` — fails fast with "another aio-proxy instance is already running, see <pid> at <path>" if locked. (Skipped for `--readonly` reads, e.g. `aio-proxy trace prune --dry-run`.)
4. `new Database(path, { readonly })` (bun:sqlite).
5. Apply PRAGMAs in this order, on the raw `sqlite` handle BEFORE wrapping with drizzle:
   ```sql
   PRAGMA journal_mode = WAL;
   PRAGMA busy_timeout = 5000;
   PRAGMA foreign_keys = ON;
   PRAGMA synchronous = NORMAL;
   ```
6. Run pending migrations (see below). Reject startup if `PRAGMA user_version > COMPILED_SCHEMA_VERSION` with "binary is older than database; please upgrade aio-proxy".
7. Wrap with drizzle: `const db = drizzle({ client: sqlite, schema });`
8. Return `{ sqlite, db }`.

### Migrations: build-time generate, binary-baked, deterministic
- **Build time**: `bun run build:migrations` → drizzle-kit generates `packages/core/src/db/migrations/0000_xxx.sql`, `0001_xxx.sql`, ... + a `_journal.json`. The journal is committed to git AND consumed at build-time only.
- **Embed**: `packages/core/src/db/migrations.manifest.ts` is a TypeScript file (committed, regenerated by `packages/core/scripts/build-migrations-manifest.ts` after every `drizzle-kit generate`):
  ```ts
  // AUTO-GENERATED — do not edit. Regenerate via `bun run build:migrations`.
  import sql0 from "./migrations/0000_init.sql" with { type: "text" };
  import sql1 from "./migrations/0001_add_usage.sql" with { type: "text" };
  export const COMPILED_SCHEMA_VERSION = 2;
  export const MIGRATIONS: ReadonlyArray<{ version: number; sha256: string; sql: string }> = [
    { version: 1, sha256: "...", sql: sql0 },
    { version: 2, sha256: "...", sql: sql1 },
  ];
  ```
  Each `sql` import via `with { type: "text" }` gets baked into the compiled binary by Bun. **No fallback path** — if `with { type: "text" }` doesn't work in the pinned Bun version, the build FAILS and we upgrade Bun (the runtime fs-read fallback would break the "no runtime fs reads" promise). Validated in todo 22's spike.
- **Runtime**: `applyMigrations(sqlite)` reads `PRAGMA user_version`, refuses to start if newer than `COMPILED_SCHEMA_VERSION`, then for each `m of MIGRATIONS.slice(current)`:
  1. Verify `sha256Sync(m.sql) === m.sha256`; if mismatch, throw `MigrationHashMismatchError` with message `"migration v${version} (${file}) hash mismatch; binary expected ${expected}, got ${actual}. Re-run \`bun run build:migrations && bun packages/core/scripts/build-migrations-manifest.ts\` to regenerate the manifest, or revert the SQL change."` (Oracle v4 #7 fix — DX-friendly error). Defense-in-depth against tampering or partial-bundle corruption (Oracle 5 fix).
  2. `sqlite.transaction(() => { sqlite.exec(m.sql); sqlite.exec(\`PRAGMA user_version = ${m.version}\`); })()`.
  `user_version` IS the migration cursor — no separate `__drizzle_migrations` table. Rationale for not using drizzle-orm's built-in `migrate()`: it expects to read SQL files from disk at runtime, but our binary has no disk access for migrations; we use `user_version` as the cursor and verify each baked SQL by sha256 before exec.
- **Determinism**: migration files are committed; F1 re-runs `drizzle-kit generate` in a clean dir and asserts no diff in `migrations/` and `migrations.manifest.ts`. Schema change without committed migration → F1 rejects the implementation.
- **Rollback**: NOT supported in MVP (Phase 2). Migrations are forward-only (D55).

### Schema files (drizzle, by package responsibility)
- `packages/core/src/db/schema/traces.ts` — owned by core
- `packages/core/src/db/schema/usage.ts` — owned by core
- `packages/core/src/db/schema/auth.ts` — **importable ONLY by `packages/auth-flows/src/store.ts`** (D46 + F1 mechanical audit). Schema:
  ```ts
  export const auth = sqliteTable("auth", {
    vendor: text("vendor").notNull(),
    providerId: text("provider_id").notNull(),
    accountFingerprint: text("account_fingerprint"),  // nullable on first insert; required for subsequent CAS writes (D78)
    payload: text("payload").notNull(),               // opaque JSON
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  }, (t) => [primaryKey({ columns: [t.vendor, t.providerId] })]);
  ```
- `packages/core/src/db/schema/models_dev_cache.ts` — owned by core (models.dev catalog cache)
- `packages/core/src/db/schema/index.ts` — re-exports `traces`, `usage`, `models_dev_cache`; does NOT re-export `auth` (callers wanting auth must import the file path directly, which the lint catches outside auth-flows).

### `Auth.cas` API (D78 detailed signature)

`packages/auth-flows/src/store.ts` exposes:

```ts
export class StaleProviderGenerationError extends Error {
  constructor(
    public readonly vendor: string,
    public readonly providerId: string,
    public readonly expected: string | null,
    public readonly actual: string | null,
  ) { super(`auth row for ${vendor}:${providerId} has fingerprint ${actual}, expected ${expected}`); }
}

export class AuthCasBusyError extends Error {
  constructor(
    public readonly vendor: string,
    public readonly providerId: string,
    public readonly cause: unknown,
  ) { super(`auth row for ${vendor}:${providerId} is busy, retry later`); }
}

/**
 * Compare-and-set write to the auth table, atomic under SQLite WAL.
 * - If `expectedFingerprint === null`: only inserts a new row (fails if any row exists with non-null fingerprint).
 * - Else: requires the existing row to have `accountFingerprint === expectedFingerprint`; otherwise rolls back with `StaleProviderGenerationError`.
 * The mutator runs INSIDE the transaction; throwing rolls back; the returned object is written.
 * Uses `sqlite.transaction(..., "immediate")` so the BEGIN IMMEDIATE acquires a write lock at the start (no read-then-write race under concurrent WAL writers).
 * Synchronous (drizzle bun-sqlite is sync; consistent with `bun:sqlite`).
 */
export function cas(
  vendor: string,
  providerId: string,
  expectedFingerprint: string | null,
  mutator: (current: { payload: unknown; accountFingerprint: string | null } | null) => {
    payload: unknown;                  // will be JSON.stringify'd
    accountFingerprint: string;         // new fingerprint (always non-null on write)
  },
): void;
```

Implementation pattern (Bun `sqlite.transaction()` API correctly used — `transaction(fn)` returns a callable wrapper; the `.immediate()` method on that wrapper acquires `BEGIN IMMEDIATE`. The wrapper does NOT inject a `tx` parameter; the inner function uses the captured `sqlite` handle directly. Inner errors are re-thrown after rollback. The mutator MUST be SYNCHRONOUS — async mutators commit before the Promise resolves and break atomicity):

```ts
const { sqlite } = openDb();
const defaultBusyTimeoutMs = 5000;
const requestPathBusyTimeoutMs = 350;
const casTx = sqlite.transaction(() => {
  const existing = sqlite.prepare(
    "SELECT account_fingerprint, payload FROM auth WHERE vendor=? AND provider_id=?"
  ).get(vendor, providerId) as { account_fingerprint: string | null; payload: string } | null;

  if (expectedFingerprint === null) {
    if (existing && existing.account_fingerprint !== null) {
      throw new StaleProviderGenerationError(vendor, providerId, null, existing.account_fingerprint);
    }
  } else {
    if (!existing || existing.account_fingerprint !== expectedFingerprint) {
      throw new StaleProviderGenerationError(
        vendor, providerId, expectedFingerprint, existing?.account_fingerprint ?? null,
      );
    }
  }

  const next = mutator(
    existing ? { payload: JSON.parse(existing.payload), accountFingerprint: existing.account_fingerprint } : null,
  );

  // Strict CAS at SQL level: the WHERE clause matches "expected null AND existing null" OR "expected = existing".
  const result = sqlite.prepare(
    `INSERT INTO auth (vendor, provider_id, account_fingerprint, payload, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(vendor, provider_id) DO UPDATE SET
       account_fingerprint = excluded.account_fingerprint,
       payload = excluded.payload,
       updated_at = excluded.updated_at
     WHERE (?2 IS NULL AND auth.account_fingerprint IS NULL)
        OR (?2 IS NOT NULL AND auth.account_fingerprint = ?2)`
  ).run(vendor, providerId, next.accountFingerprint, JSON.stringify(next.payload), Date.now(), expectedFingerprint);

  if (result.changes === 0) {
    // Defense-in-depth: if both JS check and SQL CAS pass, this should never fire.
    // If it does, the row was concurrently mutated between the SELECT and the UPDATE.
    throw new StaleProviderGenerationError(vendor, providerId, expectedFingerprint, "<concurrent>");
  }
});

sqlite.exec(`PRAGMA busy_timeout = ${requestPathBusyTimeoutMs}`);
try {
  casTx.immediate();   // BEGIN IMMEDIATE — acquires write lock at start, no read-then-write race.
} catch (error) {
  if (String(error).includes("SQLITE_BUSY")) {
    throw new AuthCasBusyError(vendor, providerId, error);
  }
  throw error;
} finally {
  sqlite.exec(`PRAGMA busy_timeout = ${defaultBusyTimeoutMs}`);
}
```

The double check (JS-side fingerprint compare + SQL `WHERE` CAS clause + `result.changes === 0` audit) is intentional defense-in-depth (Oracle 2 fix). `StaleProviderGenerationError` means the fingerprint changed. It MUST NOT be used for lock contention. Any `SQLITE_BUSY` or `SQLITE_BUSY_*` raised by `BEGIN IMMEDIATE` or the write path becomes `AuthCasBusyError`, and upper layers map that to a retryable 503 plus a localized retry message. Request-path CAS uses a short 250-500ms busy timeout, this plan standardizes on **350ms**, then restores the normal 5000ms connection default in `finally`. Stress test (todo 24): 50 concurrent CAS writers with mismatched expected fingerprints → exactly the matching one wins (`changes === 1`), others throw `StaleProviderGenerationError`.

## IR Fitness Contract (provider-specific field carriage)
> Every transform/egress todo MUST encode and round-trip-test these mappings. This is the single source of truth — when an adapter PR contradicts this table, the table wins (or the table is updated in the same PR with a justification).

| Source field | Internal carriage (ModelMessage / StreamPart) | Notes / failure mode if breached |
| --- | --- | --- |
| Anthropic `messages[].content[].cache_control` | `ModelMessage.providerOptions.anthropic.cacheControl` on the corresponding part/message | Must round-trip Anthropic→Anthropic byte-equivalent. Cross-protocol egress simply omits (cache_control has no equivalent in OpenAI/Gemini). |
| Anthropic `thinking` content block + `signature` | ai-sdk `reasoning` stream part with `text` = thinking text and `providerMetadata.anthropic = { signature, encryptedContent? }` | Anthropic→Anthropic must preserve signature byte-for-byte (replaying with thinking back to Claude requires it). Cross-protocol → emit text-only as reasoning summary; drop signature; trace logs `dropped: anthropic.signature`. |
| Anthropic top-level `system` (string or content array) | First message in `ModelMessage[]` with role `"system"` | Reverse: when egressing to Anthropic, extract leading system message back to top-level. |
| OpenAI Chat / Responses `reasoning_effort` (`"low"|"medium"|"high"`) | `providerOptions.openai.reasoningEffort` on settings | Cross-protocol to Anthropic: map `high` → `thinking_budget: 8192`, `medium` → `4096`, `low` → `1024`; to Gemini: drop with trace warning (no equivalent). |
| OpenAI Responses `reasoning.summary` event | `reasoning` stream parts with `providerMetadata.openai.summary = true` | Egress for OpenAI Responses emits `response.reasoning_summary_*` events; OpenAI Chat egress flattens to `delta.reasoning` (non-standard but recognized by some clients) OR drops with warning if `chat.reasoning_drop_strict: true`. |
| OpenAI Responses `previous_response_id` | **NOT carried**. Returns 501 at ingress. | Plan-level guarantee: stateful Responses continuation is unsupported in MVP. Silent drop is forbidden. |
| OpenAI o1/o3 `tool_calls` with parallel calls | Standard `tool-input-start` / `tool-input-delta` / `tool-input-end` parts | Standard ai-sdk shape; nothing special. |
| Gemini `inlineData` (base64 + mediaType) | ai-sdk file/image part `{ type: "file", mediaType, data: <base64 string> }` on user message | M3 introduces this. Vision-OUT-of-scope for M2 transforms (text+tool only there). Cross-protocol to OpenAI Chat → encode as `image_url` with data URL; to Anthropic → `image` block with base64 source. |
| Gemini `functionCall` / `functionResponse` | `tool-call` part / `tool-result` part respectively | Round-trip Gemini→Anthropic test must verify the role-mapping (Gemini `model` role with functionCall ↔ Anthropic assistant `tool_use`; Gemini `user` with functionResponse ↔ Anthropic user `tool_result` content block). If lossy → fixture marked `lossy: true` with reason in test. |
| Gemini `safetySettings` / `safetyRatings` | `providerOptions.google.safetySettings` (request) / drop with trace warning (response) | Cross-protocol can't carry; documented. |
| DeepSeek (openai-compatible) `delta.reasoning_content` | Custom SSE parser in `core/provider/openai-compatible-reasoning.ts` translates to ai-sdk `reasoning` stream part | `@ai-sdk/openai-compatible` does NOT do this natively; we wrap. OpenAI Chat egress recreates `delta.reasoning_content` for OpenAI Chat ingress (same wire protocol round-trip). |
| Anthropic prompt caching headers (`anthropic-beta: prompt-caching-*`) | Forwarded by api-kind passthrough; transform path sets `providerOptions.anthropic.cacheControl` per-block instead | Documented as "passthrough-only feature". |
| GitHub Copilot custom headers (`Editor-Version`, `Copilot-Integration-Id`) | Injected by `core/provider/subscription/github-copilot.ts` `fetch` wrapper, never visible to ingress or other providers | Trace masks these (they're subscription-internal). |

**Round-trip discipline:** every `protocol→ModelMessage→protocol` pairing MUST have at least one fixture covering the rows in this table that apply. The fixture file lives at `packages/core/_test/fixtures/<ingress-protocol>/<feature>.json` and is referenced from the relevant todo's QA scenarios.


> Zero human intervention - all verification is agent-executed.
- Test decision: **TDD** for adapters and config zod schemas (golden-file driven); tests-after for plumbing where the spec is unambiguous; framework = Bun's built-in `bun test` for unit + integration, plus a Bun-spawned mock-upstream harness for e2e.
- Lint+type gates: `bun run check` aggregates `biome check` + `tsc --noEmit -p packages/<each>/tsconfig.json`.
- Build gate: `bun run build:binary --target=bun-<host>` must produce a runnable binary that `aio-proxy --version` smokes successfully in CI.
- Evidence: each task writes to `.omo/evidence/task-<N>-aio-proxy.<ext>` (bun test JUnit output, `aio-proxy --probe` JSON, `curl /v1/...` SSE stream snapshot).

## Execution strategy

### Commit discipline (D116)
Every implementation todo is an atomic commit boundary. A worker may mark a todo complete only after code, tests/QA, and the required `.omo/evidence/...` artifact are present; immediately after that, the worker MUST create the todo's listed conventional commit before starting the next todo. Do NOT batch multiple todos into one commit. Do NOT leave a completed todo uncommitted while continuing to later todos. If a todo spans multiple files, those files still commit together as that todo's single commit.

### Parallel execution waves
> Target 5-8 todos per wave. Each milestone produces one wave.

| Wave | Milestone | Goal | Verification |
|---|---|---|---|
| W1 | M1 | Monorepo skeleton (7 packages) + Hono boots on :22078 + zod config schema parses + Biome+tsc green + ai-sdk versions catalog-pinned | `bun run check` passes; `curl :22078/health` returns 200; `grep -r '@ai-sdk' packages/types/src` returns nothing |
| W2 | M2 | OpenAI Chat ingress + openai-compatible api provider + same-protocol passthrough + first cross-protocol (OpenAI→Anthropic) via ai-sdk; ai-sdk imports contained in `core/src/ai-sdk-bridge/*` | unit golden + integration test using Hono testClient + e2e smoke through real `openai` SDK |
| W3 | M3 | Add Anthropic Messages + Gemini + OpenAI Responses ingress + passthrough for each + cross-protocol matrix complete; **IR Fitness Contract round-trip fixtures landed** (cache_control, thinking signature, inlineData, reasoning_effort) | golden files for each ingress; matrix integration test 4×4=16 paths green via real ai-sdk + HTTP-level mocks (todo 17) |
| W4 | M4 | BUNDLED_PROVIDERS (8 packages) + **gated** runtime `npm.add` fallback (no auto-install on serve) + `aio-proxy provider install <pkg>` CLI + 4-stage hot-reload + SSE bounded backpressure + first-class `ai-sdk` provider kind in config; **build-and-spike validates `process.execPath + BUN_BE_BUN=1` works in compiled binary** (Oracle BLOCKING fix) | unit: load each bundled; integration: install + load `@ai-sdk/cohere` from cache via the binary self-spawn |
| W5 | M5 | Subscription provider kind + GitHub Copilot vendor preset + device-code flow + endpoint token refresh with **single-flight** + Copilot LanguageModel + ProviderPreset registry powering wizard | integration: mock GitHub OAuth + Copilot endpoint; concurrent-refresh asserted; e2e: real Copilot smoke (skipped in CI w/o secrets, runs locally) |
| W6 | M6 | Dashboard SPA (Vite+React+shadcn) + provider CRUD + alias editor + trace timeline + SSE + models.dev catalog (autocomplete-only) + **`POST /dashboard/providers/install` confirm-gated**; `auth` table accessed ONLY via `auth-flows.Auth.list()` | e2e: Playwright through dashboard happy paths; dashboard response no-token-leak grep |
| W7 | M7 | `bun build --compile` matrix × 5 + GitHub Actions release pipeline + npm meta+sub-packages publish with **diagnostic shim** + `install.sh` from `raw.githubusercontent.com/<org>/aio-proxy/main` | CI: matrix produces 5 binaries; `aio-proxy --version` per platform; install.sh dry-run smoke; `--no-optional` install prints diagnostic (not crash) |
| W8 | M8 | Full e2e suite (HTTP-level mocks, real SDKs, IR Fitness regression) + README + 0.1.0 release | release tag created; 5 binaries downloadable; sample config in README produces a working request; F1-F4 APPROVE |

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 (workspace skeleton, 7 packages) | none | 2,3,4,5,35 | within W1 only after this lands |
| 2 (types/zod) | 1 | 3,4,6,35 | 4,5,35 |
| 3 (server boot) | 2 | 12,21,27 | 4,5,35 |
| 35 (i18n paraglide package) | 1,2 | 4,14,15,16,25,26,27 | 3,5 |
| 4 (cli skeleton + i18n-wrapped) | 1,2,3,35 | 25,29 | 5 |
| 5 (CI preflight + tests) | 1 | 31 | 2,3,4,35 |
| 6 (router) | 2 | 7,8,12,21 | 7 once 2 lands |
| 7 (openai-chat ingress) | 2,35 | 8,11,12,17 | 9,10 |
| 8 (transform OpenAI↔ModelMessage) | 7 | 11,13 | 9,10 |
| 9 (api passthrough provider) | 6 | 12,13 | 7,8,10 |
| 10 (ai-sdk wrapper stub, in core/ai-sdk-bridge) | 8 | 11,12,18 | 9 |
| 11 (egress OpenAI Chat SSE) | 7,10 | 12,13 | 14,15,16 |
| 12 (route /v1/chat/completions) | 6,9,10,11 | 13 | none |
| 13 (non-stream + error envelope, uses formatUserError) | 12,35 | 14,15,16 | none |
| 14 (Anthropic full stack) | 13,35 | 17 | 15,16 |
| 15 (Gemini full stack) | 13,35 | 17 | 14,16 |
| 16 (Responses full stack) | 13,35 | 17 | 14,15 |
| 17 (cross-protocol matrix) | 14,15,16 | 18 | none |
| 18 (BUNDLED map) | 10 | 19,20 | 14,15,16 |
| 19 (npm.ts self-spawn + proper-lockfile) | 18 | 20,21 | none — Oracle's BLOCKING spike must pass first |
| 20 (ai-sdk runtime + reasoning wrapper) | 18,19 | 21,24 | none |
| 21 (CLI provider + reload + SSE backpressure) | 20,35 | 27 | 22 |
| 22 (auth-flows drizzle store + isolation guard) | 4,8 (db/connect.ts hookup) | 23,24 | 21 |
| 23 (Copilot device flow) | 22,35 | 24,25 | 26 |
| 24 (Copilot LanguageModel + single-flight) | 23,20 | 25 | 26 |
| 25 (CLI login + wizard + ProviderPreset, all i18n) | 22,23,35 | 27 | 26 |
| 26 (dashboard skeleton via shadcn preset) | 1,35 | 27 | 22-25 |
| 27 (dashboard pages + dashboard Hono RPC endpoints + i18n) | 21,25,26,35 | 28 | none |
| 28 (embed dashboard in binary) | 27 | 29 | none |
| 29 (build.ts × 5 targets) | 28 | 30,31 | none |
| 30 (npm publish + diagnostic shim) | 29 | 31 | none |
| 31 (GH Releases + install.sh) | 30 | 32 | 5 already passing required |
| 32 (full e2e + IR Fitness regression) | 31 | 33 | none |
| 33 (README + config check + fill `<org>`) | 32 | 34 | none |
| 34 (cut 0.1.0) | 33, F1-F4 APPROVE | release | none |

## Todos
> Implementation + Test + Evidence + Commit = ONE todo. Never separate. Complete each todo, run its QA, write its `.omo/evidence/...` artifact, then immediately create exactly one conventional commit with the todo's listed commit message before starting another todo.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->

### Wave 1 — M1: skeleton

- [x] 1. `package.json` + workspace root: Bun monorepo with **7 packages**, Turborepo orchestration, kebab-case + composite TS, shared catalog, paraglide & preflight scripts
  What to do: Create root `package.json` with `"workspaces": { "packages": ["packages/*"], "catalog": { ... } }`, `"packageManager": "bun@1.3.14"`, `"private": true`, `"type": "module"`, `"engines": { "bun": ">=1.3.14" }`. Add `turbo` to root `devDependencies` and catalog ONLY if it is also consumed by package scripts; otherwise declare its version locally at root. Root build/check/test/preflight/dev scripts must match `## Monorepo task orchestration`. Root `preflight` MUST stay small: `i18n:compile` plus Turbo package-level `check` + `test:unit`; do NOT add root `scripts/check-*.ts` gates. **D114 — catalog is only for shared deps**: if a dependency is used by multiple packages, or by both root and a package, put the version in `workspaces.catalog` and use `"catalog:"` in each consumer. If a dependency is used by exactly one package, declare the version directly in that package's manifest. Workspace-internal deps use `"@aio-proxy/<pkg>": "workspace:*"`. `hono` is cataloged because `packages/server` imports server APIs and `packages/dashboard` imports `hono/client` for RPC. EXACT pins for `ai`/every `@ai-sdk/*`/`@openrouter/ai-sdk-provider` when cataloged or bundled; `^` ranges for runtime+dashboard+typescript+turbo; `*` for dev-only e2e SDKs where declared. Create:
    - `tsconfig.base.json` with `"strict": true`, `"noUncheckedIndexedAccess": true`, `"composite": true`, `"declaration": true`, `"declarationMap": true`, `"moduleResolution": "bundler"`.
    - Root `tsconfig.json` referencing all 7 packages.
    - `biome.json` (format + lint + organize-imports). Add an `ignore` for `packages/dashboard/src/route-tree.gen.ts` and `packages/i18n/src/paraglide/`.
    - `turbo.json` exactly following `## Monorepo task orchestration`, including explicit `outputs` for dashboard `dist/**`, binary `dist/**`, route tree, paraglide output, and migrations manifest; `dev` is `persistent: true` + `cache: false`; e2e tasks are `cache: false`.
    - `drizzle.config.ts` at root (per `## Monorepo task orchestration`).
    - `.gitignore` lines: `node_modules`, `dist`, `.omo/evidence/*`, `!\.omo/evidence/.gitkeep`, `bun-debug.log`, `packages/i18n/src/paraglide/`, `packages/dashboard/src/route-tree.gen.ts`, `packages/dashboard/dist`, `*.tsbuildinfo`.
    - 7 packages: `packages/{types,i18n,core,auth-flows,server,dashboard,cli}/package.json` each with `"name": "@aio-proxy/<pkg>"`, `"type": "module"`, `"exports"` pointing at `src/index.ts` (and codegen outputs for i18n per its section). Each `tsconfig.json` extends base + `"composite": true` + `"references"` per the dependency matrix.
    - Initial empty `.omo/evidence/.gitkeep` so the path exists.
  Must NOT do: NO root TS source code in `src/` at the workspace root; NO root `scripts/check-*.ts` files or root `*:check` scripts that only wrap static audits; NO `node_modules` committed; NO ESLint/Prettier (Biome only); NO vitest (bun test only); NO `tsx`/`tsc-watch` runners; NO ai-sdk version range specifiers (`^`/`~`) when cataloged/bundled — exact pins only; NO forcing single-package-only deps into the root catalog; NO nx / lerna (D75); NO enabling Turbo remote cache/token requirements in MVP; NO TanStack DB / lodash / dayjs / yargs / i18next / lingui / msw / chalk / marked / react-i18next added (D74/D77 forbidden); NO PascalCase file names anywhere (D76).
  Parallelization: Wave 1 | Blocked by: none | Blocks: 2, 3, 4, 5, 35
  References: opencode catalog pattern at `packages/opencode/package.json:58-76` (sst/opencode); Bun catalog docs (https://bun.sh/docs/pm/catalogs) + workspace docs (https://bun.sh/docs/pm/workspaces); Turborepo Bun workspace + task docs (https://github.com/vercel/turborepo/blob/main/apps/docs/content/docs/crafting-your-repository/structuring-a-repository.mdx); TypeScript project references docs (https://www.typescriptlang.org/docs/handbook/project-references.html); plan sections `## Dependencies`, `## Monorepo task orchestration`, `## File naming convention (D76)`.
  Acceptance criteria:
  - `bun install` exits 0.
  - `bunx turbo --version` exits 0 after `bun install`.
  - `bun run check` exits 0.
  - `bun run preflight` output includes Turbo task execution and exits 0.
  - Running `bun run preflight` twice shows at least one cache hit in the second run, captured in evidence.
  - `find packages -maxdepth 2 -name package.json | wc -l` outputs `7`.
  - `bun pm ls 2>&1 | grep -cE '@ai-sdk|^ai@|paraglide-js'` outputs `>= 10`.
  - `grep -E '"(lodash|dayjs|yargs|i18next|lingui|@lingui|msw|@tanstack/db|react-i18next|formatjs|polyglot|chalk|picocolors)"' package.json packages/*/package.json` returns nothing.
  - `find scripts -maxdepth 1 -name 'check-*.ts' 2>/dev/null | wc -l` outputs `0`.
  - Catalog policy is visible in package manifests: shared deps use `"catalog:"`, workspace-internal deps use `"workspace:*"`, and single-package-only deps carry local version ranges in the package that uses them.
  - `bun run preflight` exits 0 (paraglide compile may produce empty output if i18n package is empty stub, that's OK).
  QA scenarios: happy: `bun install && bun run preflight && bun run preflight`, redirect combined output to `.omo/evidence/task-1-aio-proxy.txt` and ensure the second preflight shows Turbo cache reuse. Failure: write `packages/types/src/_smoke.ts` containing `export const x: number = "bad" as any;`, run `bun run check`, capture non-zero exit + tsc error surfaced through Turbo to `.omo/evidence/task-1-aio-proxy-tsc.txt`, then remove the smoke file.
  Commit: Y | `chore(repo): bun monorepo with 7 packages + composite TS + turbo preflight`

- [x] 2. `packages/types`: zod v4 schemas for Config (Server, Provider variants, Models), TraceEvent, our own ModelMessage alias
  What to do: Add `zod` via the shared catalog if it is consumed by multiple packages (expected), otherwise declare it locally. In `src/index.ts` export: `ServerConfigSchema`, `ApiProviderSchema` (with `vendor: z.enum(["openai-native","anthropic-native","google-native","openai-compatible"])` and `protocol: z.enum(["openai-chat","openai-responses","anthropic-messages","gemini-generate-content"])`), `SubscriptionProviderSchema`, `AiSdkProviderSchema`, `ProviderSchema = z.discriminatedUnion("kind", [...])`, `ConfigSchema = z.object({ server, providers })`, `ModelEntrySchema = z.union([z.string(), z.object({ alias, id })])`, `TraceEventSchema` (start/delta/end/error variants), `UsageRowSchema`, plus our own `AioModelMessage` and `AioStreamPart` types as zod schemas — these are the public ABI; ai-sdk types are NEVER re-exported here (per Must-NOT).
  Must NOT do: NO runtime logic in types pkg; NO ai-sdk runtime imports; NO `import type` of `LanguageModelV2` / `ModelMessage` from ai-sdk — keep that contained in `packages/core/src/ai-sdk-bridge/*` (types pkg consumers must not transitively pull ai-sdk).
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 3, 4, 5, 6
  References: opencode `packages/core/src/v1/config/provider.ts:58-88` (sst/opencode) for `npm`/`api`/`options` shape (we mirror but simplify); zod 4 docs `discriminatedUnion`.
  Acceptance criteria: `bun test packages/types` ≥ 12 cases pass (4 valid configs incl. one of each provider kind, 6 invalid each rejected with the expected `issues[].path`, 2 trace event roundtrips); `tsc --noEmit -p packages/types` 0 errors; `grep -r '@ai-sdk' packages/types/src` outputs nothing.
  QA scenarios: happy: `bun test packages/types/_test/*.test.ts --reporter=spec > .omo/evidence/task-2-aio-proxy.txt 2>&1`; failure: feed config with `kind: "unknown"` → expect zod rejection at `providers.0.kind`, capture to `.omo/evidence/task-2-aio-proxy-fail.txt`.
  Commit: Y | `feat(types): zod schemas for config, trace events, our own message/stream alias types`

- [x] 3. `packages/server`: Hono boot on `:22078` with `/health`, `/dashboard/config GET`, secret redactor middleware, and exported Hono RPC app type
  What to do: Add `hono` via the shared catalog and declare `"hono": "catalog:"` in both `packages/server/package.json` and `packages/dashboard/package.json` so server APIs and `hono/client` resolve to the same version. In `src/server.ts` export `createServer({ config, port, host })` returning a Hono app. Create dashboard/control route modules under `packages/server/src/dashboard-routes/` and compose them with Hono's larger-app RPC pattern:
  `const dashboardRoutes = new Hono().get("/config", ...); const routes = app.route("/dashboard", dashboardRoutes); export type AppType = typeof routes;`
  Routes in this todo: `GET /health` → `{ status: "ok", uptime, version }`; `GET /dashboard/config` → returns parsed config with `redactSecrets()` applied (replaces strings matching `/^sk-[A-Za-z0-9_-]{20,}$/`, `Bearer .*`, `apiKey: ".*"` patterns inside JSON values with `"sk-****"`, etc.). Bind on `127.0.0.1` only by default. CSRF middleware checks `Origin` header allowlist `["http://127.0.0.1:22079","http://localhost:22079"]` on `/dashboard/*` POST/PUT/DELETE; absent or non-allowed → 403. Dashboard/client code MUST consume the API via `hc<AppType>()`; server and dashboard packages MUST resolve the same `hono` version. If editor/type performance degrades, add a prebuild declaration step that emits the compiled RPC client type instead of widening handlers to `any`.
  Must NOT do: NO request logging that includes Authorization; NO 0.0.0.0 listen by default; NO express/fastify; NO TLS; NO `*` CSRF allowlist.
  Parallelization: Wave 1 | Blocked by: 2 | Blocks: 6, 9, 27
  References: claude-code-router `src/server/gateway/service.ts:471-478` (musistudio/claude-code-router) for health route shape; Hono RPC docs `https://hono.dev/docs/guides/rpc#using-rpc-with-larger-applications`; Hono docs `https://hono.dev/helpers/streaming` for SSE.
  Acceptance criteria: `bun run dev` starts; `curl 127.0.0.1:22078/health` returns 200 with `status: ok` + version field; integration test asserts external IP cannot connect (bind check via `Bun.listen` introspection); TypeScript smoke imports `type { AppType } from "@aio-proxy/server"` and constructs `hc<AppType>("http://127.0.0.1:22078")` with typed `$get()` on `client.dashboard.config`.
  QA scenarios: happy: integration test with Hono `testClient`: GET `/health` → 200, log to `.omo/evidence/task-3-aio-proxy.txt`; failure: POST `/dashboard/config` with `Origin: http://evil.example` → 403, capture to `.omo/evidence/task-3-aio-proxy-fail.txt`; absent Origin on POST → 403.
  Commit: Y | `feat(server): Hono boot on :22078 with health, dashboard config GET, CSRF middleware`

- [x] 4. `packages/cli`: commander@15 entry with `serve` `dashboard` `--version` `--lang`, XDG path resolution, paraglide i18n + binary smoke
  What to do: Add `commander` and `@inquirer/prompts` locally to `packages/cli` (single-package deps), plus workspace dep on `@aio-proxy/i18n`. In `src/main.ts`:
  ```ts
  import { m, setLocale, resolveLocaleFromArgv, formatUserError } from "@aio-proxy/i18n";

  setLocale(resolveLocaleFromArgv(process.argv));   // BEFORE program build (M-O12 fix)

  function buildProgram() {
    const program = new Command()
      .description(m.cli_root_description())
      .version(packageJson.version, "-v, --version", m.cli_version_description())
      .option("--lang <locale>", m.cli_option_lang_description());
    program.command("serve")
      .description(m.cli_serve_description())
      .option("--host <host>", m.cli_serve_option_host_description())
      .option("--port <port>", m.cli_serve_option_port_description())
      // ...
      ;
    program.command("dashboard").description(m.cli_dashboard_description());
    // stubs for provider, model, trace (filled in later todos)
    return program;
  }
  buildProgram().parseAsync(process.argv);
  ```
  Commands: `serve [--host] [--port] [--dashboard] [--config <path>] [--lang <locale>]`, `dashboard`, `--version`, plus stubs for `provider`, `model`, `trace` subcommands (filled in later todos). Resolve config path: `--config` > `$AIO_PROXY_CONFIG` > `~/.config/aio-proxy/config.jsonc` (Windows: `%APPDATA%\aio-proxy\config.jsonc`). If config missing AND stdin is TTY → defer to wizard (todo 25, stub for now: write `{ server: { port: 22078, dashboardPort: 22079 }, providers: [] }`); if missing AND non-TTY → write the empty config + log `m.cli_bootstrap_empty_config({ path, dashboardUrl })`. `serve` calls `createServer` from server pkg. All `console.error(...)` user-facing outputs go through `formatUserError(err)` from `@aio-proxy/i18n`.
  **Binary smoke (M-O7 verification + M4 fallback ladder)**: as a sub-step of this todo, after the CLI works under `bun run`, build the host-target binary via `bun build --compile --target=bun-<host> packages/cli/src/main.ts --outfile dist/aio-proxy-host` and run `./dist/aio-proxy-host --version`, `--help`, `--lang zh-CN --help`, `--port 99999` (negative). Capture all four invocations to `.omo/evidence/task-4-aio-proxy-binary-smoke.txt`. **Documented fallback ladder if commander 15 ESM fails to bundle**:
    1. First fallback: pin `commander@^14` (last CommonJS-compatible major) in `packages/cli/package.json`, regenerate lockfile, rerun the same smoke. Record the decision in `RELEASE.md` "Known compatibility notes". This is the expected escape hatch — commander 14 is widely deployed and Bun-tested.
    2. Second fallback (only if commander 14 ALSO fails): swap to `cac@^7` (smaller, ESM, Bun-tested) — but re-spike all `m.cli_*()` description wiring before adopting (cac's API differs).
    3. Do NOT switch parser families without a recorded decision in `RELEASE.md` and explicit user approval.
  Surfacing: if Step 1 fails, fail todo 4 with the ladder visible in stderr; do not silently apply.
  Must NOT do: NO yargs/oclif/citty/clipanion (D67); NO stdin reads in `serve` mode once config exists; NO ANSI colors in non-TTY output; NO writing config without `mkdir -p` of parent at mode 0700; NO hardcoded user-facing English strings outside `packages/i18n/messages/en.json`; NO calling `m.*()` BEFORE `setLocale()`.
  Parallelization: Wave 1 | Blocked by: 1, 2, 3, 35 | Blocks: 25, 29
  References: commander 15 README (https://github.com/tj/commander.js); paraglide-js runtime docs (https://inlang.com/m/gerre34r/library-inlang-paraglideJs); openclaw `src/cli/program/core-command-descriptors.ts:8-23` (https://github.com/openclaw/openclaw) for command-tree shape; openclaw `src/cli/root-help-metadata.ts:26-48` for precomputed-help fast path idea (Phase 2, not MVP); plan `## i18n architecture (paraglide-js, D77)` section.
  Acceptance criteria: (a) `bun run packages/cli/src/main.ts --version` prints version from `package.json`. (b) `bun run packages/cli/src/main.ts --help` (English default) and `LANG=zh_CN.UTF-8 bun run packages/cli/src/main.ts --help` produce different localized outputs (snapshot test). (c) `--lang zh-CN --help` overrides env. (d) `serve` boots and `curl :22078/health` works; missing config dir auto-created with mode 0700. (e) `grep -rE '\.description\("[A-Za-z]' packages/cli/src` returns nothing (every description goes through `m.*()`). (f) Binary smoke succeeds: `./dist/aio-proxy-host --version` exits 0 in CI host runner. (g) Negative: `--port 99999` exits 1 with `cli_error_port_out_of_range` localized message.
  QA scenarios: happy: spawn `serve` in subprocess, hit `/health`, kill, capture stdout/stderr to `.omo/evidence/task-4-aio-proxy.txt`; English help to `.omo/evidence/task-4-aio-proxy-help-en.txt`; `LANG=zh_CN.UTF-8` help to `.omo/evidence/task-4-aio-proxy-help-zh.txt`; binary smoke quartet to `.omo/evidence/task-4-aio-proxy-binary-smoke.txt`. Failure: `--port 99999` → exit 1 with localized error captured to `.omo/evidence/task-4-aio-proxy-fail.txt`; `--config /etc/forbidden.json` → exit 1 with localized permission error.
  Commit: Y | `feat(cli): commander 15 + paraglide i18n + --lang pre-scan + binary smoke`

- [x] 35. `packages/i18n`: paraglide-js skeleton + `messages/{en,zh-CN}.json` seed + `resolveLocale()` + `formatUserError()` + compile script
  What to do: Create `packages/i18n/`:
    - `messages/en.json`: canonical message dictionary, snake_case keys with scope prefix. Seed: `cli_root_description`, `cli_serve_description`, `cli_dashboard_description`, `cli_provider_description`, `cli_model_description`, `cli_trace_prune_description`, `cli_error_port_out_of_range` (`"Port {port} is out of range (1-65535)"`), `cli_error_config_not_found`, `cli_error_config_invalid`, `cli_bootstrap_empty_config` (`"Config bootstrapped at {path}. Edit it or open the dashboard at {dashboardUrl}."`), `error_provider_not_installed` (`"Provider package not installed: {pkg}. Run \`aio-proxy provider install {pkg}\` first."`), `error_alias_collision` (`"Alias collision: {alias} is provided by both {providerA} and {providerB}. Rename one or use the provider/alias syntax."`), `error_invalid_locale`, `wizard_provider_select_prompt`, `wizard_apikey_prompt`, `wizard_confirm_install_risk`, `wizard_done`, `dashboard_routes_index_placeholder` (similar for `providers`/`models`/`traces`/`usage`/`settings`), `common_cancel`, `common_confirm`, `common_loading`, `common_save`, `common_delete`.
    - `messages/zh-CN.json`: partial Chinese translations (translate at least the cli/error/common namespaces; leave wizard/dashboard placeholders if needed — paraglide falls back to en at compile time and reports them via `inlang lint`).
    - `project.inlang/settings.json`:
      ```json
      {
        "$schema": "https://inlang.com/schema/project-settings",
        "baseLocale": "en",
        "locales": ["en", "zh-CN"],
        "modules": [
          "https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@latest/dist/index.js"
        ],
        "plugin.inlang.messageFormat": { "pathPattern": "./messages/{locale}.json" }
      }
      ```
    - `scripts/compile.ts`: a Bun script wrapping `bunx @inlang/paraglide-js compile --project ./project.inlang --outdir ./src/paraglide --emitTsDeclarations`. The `--emitTsDeclarations` flag is REQUIRED — it produces `src/paraglide/messages.d.ts` (declaring the typed `m` object) and `src/paraglide/runtime.d.ts`. Without it, downstream `tsc -b` fails on `import { m } from "@aio-proxy/i18n"` because the runtime module has no types. Paraglide v2 defaults to emitting `messages.js` (the runtime aggregated `m` object) and `runtime.js` (`setLocale`/`getLocale`). The compile is idempotent and runs as part of `bun run preflight`. Pin paraglide-js version in the catalog so default output structure is stable.
    - `src/resolve.ts`: `resolveLocale(env?: { lang?: string }): "en" | "zh-CN"` implementing the chain `--lang > AIO_PROXY_LANG > LC_ALL > LC_MESSAGES > LANG > LANGUAGE > Intl > "en"`; normalizes `zh_CN.UTF-8` / `zh-Hans` / `zh` → `"zh-CN"`. Also exports `resolveLocaleFromArgv(argv: string[])` that scans argv for `--lang <value>` (or `--lang=<value>`) without a full parse.
    - `src/format-error.ts`: `formatUserError(err: unknown, locale: Locale): { code: string; message: string }`. Side-effect-free (D93). Switches on `AppError` (custom), `ProviderNotInstalledError`, `AliasCollisionError`, zod `ZodError`, Hono `HTTPException`, and produces messages by calling **paraglide per-call locale override**: `m.error_provider_not_installed({ pkg }, { locale })`. For no-arg messages: `m.error_internal_unexpected({}, { locale })`. **MUST NOT** call `setLocale()` — that mutates module-level state and races across concurrent server requests (D93). F1 mechanically greps that no `setLocale(` call exists inside `packages/server/src/**` or `packages/i18n/src/format-error.ts`.
    - `src/index.ts`: re-exports the **aggregated `m` object** from paraglide codegen via `export { m } from "./paraglide/messages"`. This is the canonical pattern: paraglide compiles `messages/*.json` into a single `m` object whose properties are typed message functions, plus a sibling `.d.ts` declaration file with each function's exact param signature inferred from the message template. Consumers do `import { m } from "@aio-proxy/i18n"` and call `m.cli_serve_description()` / `m.error_provider_not_installed({ pkg })`. Also re-export `setLocale` / `getLocale` from `./paraglide/runtime`, plus our own `resolveLocale`, `resolveLocaleFromArgv`, `formatUserError`, `StaleProviderGenerationError`, `Locale` type alias.

    Paraglide compile must emit both runtime `m` object AND `messages.d.ts` types. Use the **default `outputStructure: "message-modules"`** (per inlang plugin-message-format docs) and rely on the explicit `--emitTsDeclarations` compile flag throughout the plan. Verify in todo 35's acceptance that `packages/i18n/src/paraglide/messages.d.ts` exists and contains a `declare const m: { ... }` shape.
  - Add `.gitignore` line `packages/i18n/src/paraglide/` (codegen output not committed).
  - Add `packages/i18n/scripts/sync-keys.ts` (Phase 1.5 — copies missing keys from `en.json` to `zh-CN.json` as `"TODO: <english value>"` markers; idempotent; safe to run repeatedly).
  - Test fixtures in `_test/`: `resolve-locale.test.ts` (env chain priority + zh-Hans normalization), `format-error.test.ts` (zod / AppError / Hono error → localized message + stable code; ASSERTS no `setLocale(` call happens during the test by spying on the runtime), `compile-output.test.ts` (asserts `src/paraglide/messages.js` and `messages.d.ts` exist and `m` is the aggregated typed object with each MVP message function and correct param shape).
  - **Tree-shaking spike (M1 empirical guard)** in `_test/tree-shake-spike.test.ts`: generate a temp copy of the inlang project, inject 100 dummy messages (`spike_msg_001` through `spike_msg_100`) into `messages/en.json` and optionally mirrored placeholders into `messages/zh-CN.json`, run paraglide compile in that temp project, then run `bun build --bundle --target=bun --minify` against a tiny entrypoint that imports only `m.spike_msg_001()`, and record whether the output still contains `spike_msg_050`. Do NOT use `messages/spike.json`, because the configured `pathPattern` treats filenames as locales. As of Bun 1.3.14 + Paraglide 2.20.2, aggregated `m` keeps unused message names in the bundle; the test should assert and document that observed fallback (accepted MVP size hit), not fake an absence result. Dashboard/binary size gates remain the enforcement mechanism.
  Must NOT do: NO i18next/Lingui/formatjs/react-i18next (D77 forbidden); NO runtime JSON fetch / lazy `import()` per-locale (MVP both bundled); NO ICU plural / select features in MVP (paraglide supports them, but we defer); NO committing `src/paraglide/` (it's codegen); NO writing English literals in `format-error.ts` outside the `m.*` calls.
  Parallelization: Wave 1 | Blocked by: 1, 2 | Blocks: 4, 14, 16, 25, 26, 27 (every user-facing string)
  References: paraglide-js docs (https://inlang.com/m/gerre34r/library-inlang-paraglideJs); inlang plugin-message-format (https://inlang.com/m/reootnfj/plugin-inlang-messageFormat); openclaw `src/wizard/i18n/index.ts:18-85` for the resolve chain pattern (we adopt the resolution order, not the old runtime-dictionary mechanism); openclaw `ui/src/i18n/lib/translate.ts:50-58` for dashboard locale pattern; this plan's `## i18n architecture (paraglide-js, D77)` section.
  Acceptance criteria:
  - `bun --filter '@aio-proxy/i18n' run compile` produces `src/paraglide/messages.js` + `src/paraglide/messages.d.ts` + `src/paraglide/runtime.js` + `src/paraglide/runtime.d.ts`.
  - `bun test packages/i18n/_test/` ≥ 6 cases pass.
  - `tsc -b packages/i18n` exits 0.
  - **`m` object exists with typed functions**: `bunx tsc --noEmit -e 'import { m } from "@aio-proxy/i18n"; m.cli_serve_description();'` exits 0 (correct call).
  - **Missing key = TS error**: `bunx tsc --noEmit -e 'import { m } from "@aio-proxy/i18n"; m.does_not_exist();'` exits non-zero (function does not exist on `m`).
  - **Missing required param = TS error**: `bunx tsc --noEmit -e 'import { m } from "@aio-proxy/i18n"; m.cli_error_port_out_of_range();'` exits non-zero (TS reports the missing `{ port }` argument).
  - **Correct param call passes**: `bunx tsc --noEmit -e 'import { m } from "@aio-proxy/i18n"; m.cli_error_port_out_of_range({ port: 99999 });'` exits 0.
  - `grep -E '"(i18next|@lingui|@formatjs|react-i18next|polyglot)"' packages/i18n/package.json` returns nothing.
  - `cat packages/i18n/src/paraglide/messages.d.ts | head -5` shows `declare const m:` (proves the aggregated typed object is emitted, not bare per-message exports).
  QA scenarios: happy: `bun --filter '@aio-proxy/i18n' run compile && bun test packages/i18n/_test/ > .omo/evidence/task-35-aio-proxy.txt 2>&1` plus `ls packages/i18n/src/paraglide/ >> .omo/evidence/task-35-aio-proxy.txt`. Failure: write a TS test file calling `m.bogus_key()`, run `tsc -b packages/i18n`, capture non-zero exit + TS error path to `.omo/evidence/task-35-aio-proxy-fail.txt`, then revert.
  Commit: Y | `feat(i18n): paraglide-js + en/zh-CN seed + resolve + format-error`

  *Note on numbering:* this todo is the i18n package skeleton, executed within Wave 1 alongside todos 1-5 but assigned number 35 to keep M2-M8 stable. Final wave list runs 1-5, 35, 6-34. Dependency edges in `## Dependency matrix` reflect this.

- [x] 5. CI: GitHub Actions `ci.yml` runs `preflight` + `test:all`, pinned to bun 1.3.14, with Playwright browser cache
  What to do: `.github/workflows/ci.yml` runs on push + PR. **Two jobs** (run in parallel where possible):
    1. **`preflight-and-unit`** (ubuntu-latest):
       - checkout
       - `oven-sh/setup-bun@v2` with `bun-version: "1.3.14"`
       - `bun install --frozen-lockfile`
       - `bun run preflight` (runs `i18n:compile`, then Turbo package `check` + `test:unit`; no custom root `scripts/check-*.ts` gates)
       - `bun run test:unit`
       - `bun run test:e2e:api` (Bun.serve mock upstream + bun test runner)
       - cache `~/.bun/install/cache` keyed on `bun.lock`
    2. **`dashboard-e2e`** (ubuntu-latest, depends on `preflight-and-unit`):
       - checkout + setup-bun + install
       - `bun run i18n:compile && bun run build:dashboard` (so dashboard `dist/` exists)
       - `bunx playwright install --with-deps chromium` with cache
       - start a backgrounded `aio-proxy serve` (via `bun run --filter '@aio-proxy/cli' start &` against a temp `$HOME` containing a fixture config)
       - wait for `:22078/health`
       - `bunx playwright test`
  Add `.gitignore` (node_modules, dist, .omo/evidence/*, !.omo/evidence/.gitkeep, .DS_Store, bun-debug.log, *.tsbuildinfo, packages/i18n/src/paraglide/, packages/dashboard/src/route-tree.gen.ts). Add `LICENSE` (MIT, `<author>` placeholder filled at todo 33).
  Must NOT do: NO matrix-build of binaries yet (that's M7); NO Codecov/Snyk/Slack; NO secret-scanning (Phase 2); NO nx/lerna; NO Turbo remote cache requirement or secret in MVP CI; NO running `bunx playwright test` without a built dashboard + running server (would fail with confusing errors).
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 31
  References: codebase-foundation/codebase-cli `.github/workflows/build-binaries.yml:24-80` for setup-bun pattern; Playwright CI guide (https://playwright.dev/docs/ci).
  Acceptance criteria: pushing a draft branch triggers BOTH workflows; total wall-clock ≤ 6 min on a fresh runner; both jobs green; Playwright cached after first run.
  QA scenarios: happy: push a draft branch → both workflow runs green; save Actions URL + summary to `.omo/evidence/task-5-aio-proxy.txt`. Failure 1 (TS): introduce a `tsc` error in `packages/types/src/_smoke.ts`, push, expect red on `bun run check`, capture log URL to `.omo/evidence/task-5-aio-proxy-tsc.txt`, revert. Failure 2 (i18n missing key): in `packages/cli/src/main.ts` call `m.bogus_key()`, push, expect red on `bun run check` (TS compile error), capture to `.omo/evidence/task-5-aio-proxy-i18n.txt`, revert. Failure 3 (Playwright): break a dashboard route so `bunx playwright test` cannot find the expected providers view, push, expect red on the `dashboard-e2e` job, capture to `.omo/evidence/task-5-aio-proxy-dashboard.txt`, revert.
  Commit: Y | `chore(ci): GitHub Actions preflight + unit + e2e api + Playwright dashboard, pinned bun 1.3.14`

### Wave 2 — M2: OpenAI Chat ingress + first cross-protocol path

- [x] 6. `packages/core/router`: alias resolver (model → provider+id), conflict detection
  What to do: Implement `Router.resolve(model: string): { provider: ProviderInstance; modelId: string }`. Build at config-load time a `Map<alias, [provider_id, model_id]>` plus `Map<"provider/alias", ...>`. Detect collisions (two providers expose same alias) → throw with both provider ids in message. Allow override `model: "<provider-id>/<alias>"`. Unit-test all four cases: simple alias, fully-qualified, collision error, missing alias 404 sentinel.
  Must NOT do: NO fallback chains; NO LRU; NO regex matching.
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 7, 8, 11
  References: opencode `packages/opencode/src/provider/provider.ts:1409-1415` for layered npm/baseURL resolution (we reuse the LAYERED IDEA, not the code).
  Acceptance criteria: `bun test packages/core/_test/router.test.ts` 8/8 pass.
  QA scenarios: happy: feed config with copilot/sonnet → `resolve("sonnet")` returns `(copilot, claude-sonnet-4-5)` (evidence task-6); failure: two providers both alias "gpt-4o" → constructor throws including both `provider.id`s.
  Commit: Y | `feat(core/router): alias resolver with collision detection and provider/alias override`

- [x] 7. `packages/core/ingress`: OpenAI Chat Completions wire schema (zod) + parser
  What to do: In `core/src/ingress/openai-chat.ts` define `OpenAIChatRequestSchema` (zod) covering: `model`, `messages[]` (system/user/assistant/tool roles), `tools[]`, `tool_choice`, `stream`, `temperature`, `max_tokens`/`max_completion_tokens`, `response_format`, `reasoning_effort`. Export `parseOpenAIChat(body): OpenAIChatRequest`. Test with golden fixtures from real OpenAI requests captured under `packages/core/_test/fixtures/openai-chat/*.json` (use Continue's openai-adapters as a reference dataset).
  Must NOT do: NO transformation to ModelMessage in this todo (next todo); NO response parsing yet; NO Azure-specific extensions.
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 8, 11, 13
  References: continuedev/continue `packages/openai-adapters/src/apis/base.ts:41-63` ChatCompletionCreateParams shape; OpenAI platform docs.
  Acceptance criteria: 6 fixture files parse without throw; 3 invalid fixtures reject at known paths.
  QA scenarios: happy: `bun test packages/core/_test/ingress/openai-chat.test.ts` (evidence task-7 includes test output); failure: bad role string "human" → zod rejects at `messages.0.role`.
  Commit: Y | `feat(core/ingress): OpenAI Chat Completions wire schema with golden fixtures`

- [x] 8. `packages/core/transform`: `OpenAIChat → ModelMessage[]` adapter (round-trip golden test)
  What to do: Implement `openaiChatToModelMessages(req): { messages: ModelMessage[]; tools: LanguageModelV2FunctionTool[]; settings: {...} }`. Implement reverse `modelMessagesToOpenAIChat(...)`. For each fixture in M7, run round-trip: parse → convert → convert back → assert deep-equal modulo known-lossy fields (tool_call_id ordering). Wire ai-sdk types via `import type { ModelMessage } from "ai"`.
  Must NOT do: NO Anthropic-specific shape leakage (system as separate field) — that goes in the Anthropic adapter; NO multimodal yet (text + tool only in MVP); NO reasoning encoding yet (handle in M3).
  Parallelization: Wave 2 | Blocked by: 7 | Blocks: 11, 13
  References: ai-sdk `packages/provider/src/language-model/v2/language-model-v2-prompt.ts:14-177`; continue `packages/openai-adapters/src/apis/Anthropic.ts:162-178` for tool_call mapping shape.
  Acceptance criteria: 6 fixtures round-trip equal; 1 explicitly lossy fixture documented in test.
  QA scenarios: happy: bun test (evidence task-8); failure: tool_calls missing `function.name` → conversion throws with field path.
  Commit: Y | `feat(core/transform): OpenAI Chat ↔ ModelMessage with round-trip tests`

- [x] 9. `packages/core/provider/api`: openai-compatible api provider, SSE byte passthrough
  What to do: `core/src/provider/api.ts` exports `createApiProvider(config: ApiProviderSchema): ProviderInstance` with method `passthrough(req: Request): Promise<Response>`. Construct upstream `Request` rewriting `host` + `Authorization: Bearer ${apiKey}` (resolve `$ENV_VAR`). For streaming, return upstream `Response` directly so Hono's `c.body(upstream.body)` pipes raw bytes. Inline trace recording: tee body via `ReadableStream.tee()` → record one branch into trace pipeline.
  Must NOT do: NO body transformation in passthrough; NO retry on stream-mid failure; NO custom user-agent that hides aio-proxy (we set `X-Forwarded-By: aio-proxy/<version>`).
  Parallelization: Wave 2 | Blocked by: 6 | Blocks: 11, 13, 19
  References: claude-code-router `src/server/gateway/service.ts:672-742` for byte-passthrough wrapping pattern.
  Acceptance criteria: integration test against a Bun-spawned mock `httpbin`-style server confirms bytes equal end-to-end and trace contains the expected hash.
  QA scenarios: happy: stream of 50 SSE chunks arrives byte-identical (evidence task-9: hash of streamed body); failure: upstream returns 429 → passthrough surfaces 429 + trace records error category=rate_limit.
  Commit: Y | `feat(core/provider/api): openai-compatible passthrough provider with stream-tee tracing`

- [x] 10. `packages/core/provider/ai-sdk`: ai-sdk wrapper using `streamText` + `LanguageModelV2/V3`
  What to do: `core/src/provider/ai-sdk.ts` exports `createAiSdkProvider(config: AiSdkProviderSchema)` with method `invoke(req: ModelMessage[], settings, tools, signal): ReadableStream<LanguageModelV2StreamPart>`. Internally `streamText({ model: <resolvedFromBundledLoader>, messages, tools, abortSignal })` and return `result.fullStream`. The `<resolvedFromBundledLoader>` is implemented in todo 16; this todo stubs it with a hardcoded `@ai-sdk/openai` import only.
  Must NOT do: NO npm fallback yet (todo 16); NO multi-step agent loop; NO `result.toDataStreamResponse()` (we manage SSE encoding in the egress).
  Parallelization: Wave 2 | Blocked by: 8 | Blocks: 11, 16
  References: vercel/ai `packages/provider/src/language-model/v2/language-model-v2.ts:14-136`; ai sdk `streamText` docs.
  Acceptance criteria: integration test feeds a mocked `LanguageModelV2.doStream` returning 3 stream parts; provider yields exactly those 3 parts.
  QA scenarios: happy: bun test with mocked LanguageModelV2 (evidence task-10); failure: model throws → provider re-throws with provider id wrapped.
  Commit: Y | `feat(core/provider/ai-sdk): streamText wrapper for V2/V3 LanguageModel`

- [x] 11. `packages/core/egress`: `LanguageModelV2StreamPart → OpenAI Chat SSE` writer
  What to do: `core/src/egress/openai-chat.ts` exports `writeOpenAIChatSSE(stream: ReadableStream<LanguageModelV2StreamPart>): ReadableStream<Uint8Array>`. Emit SSE frames matching OpenAI's `data: { id, object: "chat.completion.chunk", choices: [{ delta: {...}, ... }] }\n\n` and `data: [DONE]\n\n`. Map `text-delta` → `delta.content`, `tool-input-start/delta` accumulate into `tool_calls[i].function.arguments`, `finish` → `finish_reason`.
  Must NOT do: NO `usage` reordering hacks beyond putting it in the final chunk; NO fictional fields like `created_at`; NO non-streaming fallback in this todo (separate path).
  Parallelization: Wave 2 | Blocked by: 7, 10 | Blocks: 13
  References: continue `packages/openai-adapters/src/vercelStreamConverter.ts:83-247` is the gold reference for this exact conversion.
  Acceptance criteria: golden-test 5 streams (text-only, tool-call, tool-call+text, multi-tool, error mid-stream) match recorded OpenAI SSE byte-for-byte modulo `id` field.
  QA scenarios: happy: bun test with golden recordings (evidence task-11); failure: stream emits unknown part type → encoder logs warning + skips, does NOT crash.
  Commit: Y | `feat(core/egress): LanguageModelV2 stream → OpenAI Chat SSE encoder`

- [x] 12. `packages/server/routes/openai-chat`: wire `POST /v1/chat/completions` to router → passthrough or transform
  What to do: In `server/src/routes/openai-chat.ts` add `POST /v1/chat/completions`. Logic: parse zod → router.resolve(model) → if `provider.kind==="api"` AND `provider.protocol==="openai-chat"` AND `provider.vendor==="openai-native"` → passthrough; else → openaiChat→ModelMessage → ai-sdk provider.invoke → stream → openaiChatSSE. Always tee the response into trace pipeline.
  Must NOT do: NO short-circuit when `stream: false` in this todo (handle in 13); NO model-not-found 500 (use 404); NO request body buffering > 8MB.
  Parallelization: Wave 2 | Blocked by: 6, 9, 10, 11 | Blocks: 13
  References: claude-code-router protocol enum + dispatch in `src/server/gateway/service.ts:1577-1592,1676-1713`.
  Acceptance criteria: integration: with a config containing OpenAI api provider, a request `model=gpt-4o-mini` streams tokens; with config containing Anthropic api provider aliased "gpt-4o-mini" → request still succeeds and returns OpenAI Chat SSE shape (cross-protocol).
  QA scenarios: happy: e2e using `openai` SDK pointed at `:22078` (evidence task-12: SDK consumes stream successfully); failure: alias not found → 404 OpenAI error envelope `{ error: { type, message, code } }`.
  Commit: Y | `feat(server): /v1/chat/completions with passthrough+transform dispatch`

- [x] 13. Integration: non-streaming OpenAI Chat path + error envelope translator
  What to do: When `stream: false`, accumulate the LanguageModelV2 stream into a single `chat.completion` non-stream JSON. Add `core/src/egress/error.ts` with `toIngressError(err, ingressProtocol)` returning the protocol-native error envelope (OpenAI Chat: `{ error: { message, type, code, param? } }`). Status code mapping: ai-sdk APICallError → upstream status; AbortError → 499; everything else → 500.
  Must NOT do: NO leaking provider-id into client errors (it goes into trace, not response body); NO silently swallowing AbortSignal; NO retry once a request has actually been forwarded.
  Parallelization: Wave 2 | Blocked by: 12 | Blocks: 14, M3 ingresses (reuse pattern)
  References: continue `packages/openai-adapters/src/apis/OpenAI.ts:146-176`; ai-sdk `APICallError`.
  Acceptance criteria: 4 e2e scenarios green (stream + non-stream × passthrough + transform); 3 error scenarios produce protocol-native envelopes.
  QA scenarios: happy: `openai.chat.completions.create({ stream: false })` returns full message (evidence task-13); failure: provider returns 401 → client sees OpenAI error JSON with `type: "invalid_request_error"` (mapped) + 401 status.
  Commit: Y | `feat(server): non-streaming chat path + ingress error envelope translator`

### Wave 3 — M3: full ingress matrix (Anthropic + Gemini + OpenAI Responses)

- [x] 14. Anthropic Messages ingress: schema + transform + egress + route (cache_control + thinking signature round-trip)
  What to do: Mirror todos 7+8+11+12 for Anthropic. `core/src/ingress/anthropic-messages.ts` zod schema (system as top-level string OR content array, content blocks: text/tool_use/tool_result/thinking, each with optional `cache_control`); `core/src/transform/anthropic-messages.ts` `↔ ModelMessage` per IR Fitness Contract:
    - top-level `system` → leading system message (reverse: extract leading system message back to top-level on egress);
    - block-level `cache_control` → `ModelMessage.providerOptions.anthropic.cacheControl` on the corresponding part (reverse: write back per-block);
    - `thinking` block + `signature` → ai-sdk `reasoning` part with `text` = thinking text and `providerMetadata.anthropic = { signature, encryptedContent? }` (reverse: emit `thinking` block with signature byte-equal);
    - `tool_use` / `tool_result` content blocks → `tool-call` / `tool-result` parts (`tool_result` STAYS as content inside a user message — do not flatten into a separate role);
  `core/src/egress/anthropic-messages.ts` SSE encoder emits `event: message_start` / `content_block_start` / `_delta` / `_stop` / `message_delta` / `message_stop`; `server/src/routes/anthropic-messages.ts` `POST /v1/messages` + `POST /v1/messages/count_tokens`. Round-trip golden fixtures at `packages/core/_test/fixtures/anthropic-messages/{simple,with-cache,with-thinking,multi-tool,system-array}.json` MUST round-trip Anthropic→ModelMessage→Anthropic byte-equal (signature preserved).
  Must NOT do: NO converting `tool_result` to a separate message; NO dropping `cache_control` (preserved via `providerOptions`); NO dropping `signature` on the same-protocol path; NO cross-protocol attempt to carry `signature` to OpenAI/Gemini (it's logged as "dropped: anthropic.signature" in trace per IR Fitness Contract).
  Parallelization: Wave 3 | Blocked by: 13 | Blocks: 17
  References: opencode `packages/llm/src/protocols/anthropic-messages.ts:56-61,447-452,651-728` (sst/opencode) for thinking + tool_use mapping; LiteLLM `litellm/llms/anthropic/chat/transformation.py:296-323,1978-1991` (BerriAI/litellm) for tool_use↔tool_calls reverse mapping; this plan's `## IR Fitness Contract` rows for cache_control + thinking + system.
  Acceptance criteria: `bun test packages/core/_test/ingress/anthropic-messages.test.ts` ≥ 14 cases pass (5 round-trip fixtures × 2 directions + 4 negative); e2e using `@anthropic-ai/sdk` pointed at `:22078/v1/messages` works against an Anthropic api provider; signature byte-equality asserted on `with-thinking` round-trip.
  QA scenarios: happy: `bun test packages/core/_test/ingress/anthropic-messages.test.ts > .omo/evidence/task-14-aio-proxy.txt 2>&1`; failure: malformed `content_block_start.index` order → 400 anthropic error envelope, capture to `.omo/evidence/task-14-aio-proxy-fail.txt`.
  Commit: Y | `feat: Anthropic Messages ingress with cache_control + thinking signature round-trip`

- [x] 15. Gemini generateContent ingress: schema + transform + egress + route, including inlineData (vision) → ai-sdk file part
  What to do: Mirror for Gemini. Path `POST /v1beta/models/:model::generateContent` (non-stream) and `POST /v1beta/models/:model::streamGenerateContent` (SSE-shaped, newline-delimited JSON). Schema covers `contents[].parts[]` (text/inlineData/functionCall/functionResponse), `tools[].functionDeclarations`, `systemInstruction`, `generationConfig`, `safetySettings`. Transform per IR Fitness Contract:
    - role mapping `user`↔`user`, `model`↔`assistant` (carry `systemInstruction` to leading system message);
    - `inlineData { mimeType, data }` → ai-sdk file/image part `{ type: "file", mediaType, data: <base64 string> }`;
    - `functionCall` → `tool-call` part; `functionResponse` → `tool-result` part (round-trip Gemini→Anthropic test must verify role-mapping fidelity per IR Fitness Contract row "Gemini functionCall / functionResponse"; if lossy → fixture marked `lossy: true`);
    - `safetySettings` (request) → `providerOptions.google.safetySettings`; `safetyRatings` (response) → drop with trace warning;
  Egress emits Gemini's specific shape (newline-delimited JSON, `data: {...}\n\n` for stream).
  Must NOT do: NO Vertex-specific extensions (regional endpoints, project paths); NO multi-turn function-calling auto-loop (the agentic loop is the client's job); NO image generation parts; NO dropping `inlineData` size cap (enforce 20MB per part, return 413 above that).
  Parallelization: Wave 3 | Blocked by: 13 | Blocks: 17
  References: opencode `packages/llm/src/protocols/gemini.ts:198-201,430-448` (sst/opencode); LiteLLM `litellm/llms/vertex_ai/gemini/transformation.py:906-979` (BerriAI/litellm); IR Fitness Contract rows for `inlineData` and `functionCall`.
  Acceptance criteria: `@google/genai` SDK pointed at `http://127.0.0.1:22078` streams successfully against an aliased OpenAI provider (cross-protocol with vision input); 5 fixtures round-trip Gemini→ModelMessage→Gemini byte-equal modulo declared lossy fields.
  QA scenarios: happy: `bun test packages/core/_test/ingress/gemini.test.ts > .omo/evidence/task-15-aio-proxy.txt 2>&1` plus an e2e via `@google/genai`; failure: missing `:generateContent` suffix → 404 captured to `.omo/evidence/task-15-aio-proxy-fail.txt`; oversize `inlineData` → 413 captured similarly.
  Commit: Y | `feat: Gemini generateContent ingress with inlineData vision + functionCall round-trip`

- [x] 16. OpenAI Responses ingress: schema + transform + egress + route
  What to do: Path `POST /v1/responses` and `GET /v1/responses/:id` (we only support sync streaming, no background mode in MVP — return 501 for `background: true`). Schema follows OpenAI Responses spec (`input` is array of content/messages, `tools[]` with custom + computer-use deferred, `reasoning.summary`, `reasoning.effort`). **`previous_response_id`, `store: true`, `background: true` MUST be REJECTED with 501** (NOT silently dropped — overrides D25's silent-drop default for these stateful fields specifically); error envelope includes `{ error: { type: "unsupported_feature", message: "stateful Responses continuation is unsupported in MVP — see roadmap" } }`. Egress emits Responses-style events `response.created` / `response.output_item.added` / `response.output_text.delta` / `response.reasoning_summary_text.delta` / `response.completed`. Cross-protocol: when egressing Responses-style events from a ModelMessage stream that originated from Anthropic `thinking`, map to `response.reasoning_summary_text.*` events; signature/encrypted payload from Anthropic stays in trace metadata (per IR Fitness Contract row "Anthropic thinking + signature").
  Must NOT do: NO `background: true` (501); NO `previous_response_id` (501); NO `store: true` (501 — we don't persist Responses); NO computer-use tools; NO file_search / web_search built-in tools; NO silent drop of any of the above 3 stateful fields — they are the exception to D25.
  Parallelization: Wave 3 | Blocked by: 13 | Blocks: 17
  References: continue `packages/openai-adapters/src/apis/openaiResponses.ts:287-680,575-680` (continuedev/continue) for request/response shape; opencode `packages/llm/src/protocols/openai-chat.ts:143-147` for `reasoning_content` mapping (different but informative); IR Fitness Contract rows for `reasoning_effort` and `reasoning.summary`.
  Acceptance criteria: `openai` SDK call `client.responses.create({ stream: true })` against `:22078` works against an aliased Anthropic provider (cross-protocol); 3 negative tests assert 501 for `previous_response_id`/`store: true`/`background: true`.
  QA scenarios: happy: e2e capture to `.omo/evidence/task-16-aio-proxy.txt`; failure: `previous_response_id: "resp_x"` request → 501 with `unsupported_feature` envelope, captured to `.omo/evidence/task-16-aio-proxy-fail.txt`.
  Commit: Y | `feat: OpenAI Responses ingress (no stateful continuation in MVP — 501)`

- [ ] 17. Cross-protocol matrix integration test (16 combos = 4 ingress × 4 egress, 4 passthrough + 12 transform) using real ai-sdk packages against HTTP-level mock upstreams
  What to do: New test file `packages/server/_test/cross-protocol-matrix.test.ts` parameterized over `(ingressProtocol, providerProtocol)`. For each combo:
    1. Bun.spawn a mock upstream HTTP server speaking the provider's wire protocol (4 mocks: openai-chat / openai-responses / anthropic-messages / gemini); the mock records every received request body+headers and returns a deterministic streaming response.
    2. Configure aio-proxy with one `api`-kind provider whose `baseURL` points at the mock and `vendor` is the matching native vendor (`openai-native` / `anthropic-native` / `google-native`).
    3. Send the request through aio-proxy using **the official client SDK for the ingress protocol** (`openai`, `@anthropic-ai/sdk`, `@google/genai`).
    4. Assert: (a) ingress request was accepted and streamed; (b) the SDK consumed the full stream without error; (c) the mock upstream received a wire-correct request matching `providerProtocol` (raw body byte-level assertion against a golden fixture); (d) trace records `route_decision: "passthrough"` for the 4 same-protocol same-vendor combos and `"transform"` for the 12 cross combos; (e) for each row in the IR Fitness Contract that applies to the (ingress, egress) pair, a feature fixture round-trips correctly.
    Use **real `@ai-sdk/openai` / `@ai-sdk/anthropic` / `@ai-sdk/google`** packages on the transform path — NOT a fake echo provider — pointed at the same mocks but with `baseURL` overrides.
  Must NOT do: NO real network in this test; NO LLM invocations; NO fake echo provider on the transform path (was prior plan, now replaced); NO matrix entries that the IR Fitness Contract calls "lossy" without an explicit `lossy: true` annotation in the fixture.
  Parallelization: Wave 3 | Blocked by: 14, 15, 16 | Blocks: M4 (todo 18)
  References: this plan's `## IR Fitness Contract` table; opencode protocol fixtures at `packages/llm/src/protocols/{openai-chat,anthropic-messages,gemini}.ts` for upstream wire shapes (sst/opencode); continue `packages/openai-adapters/src/vercelStreamConverter.ts:83-247` for cross-protocol stream conversion patterns.
  Acceptance criteria: 16 combos green; 4 passthrough combos verify byte-for-byte body identity (sha256 hashes match between client-sent and upstream-received); 12 transform combos verify per-protocol shape transformation; ≥ 8 IR Fitness rows are exercised by at least one combo each.
  QA scenarios: happy: full matrix passes, capture matrix table + per-combo evidence to `.omo/evidence/task-17-aio-proxy.txt`; failure: introduce a transform-path SSE encoder bug (e.g. emit `delta.role` instead of `delta.content`) → matrix red on the affected ingress only, capture failure log + diff to `.omo/evidence/task-17-aio-proxy-fail.txt`, then revert.
  Commit: Y | `test: cross-protocol matrix (4×4=16 combos) with real ai-sdk + HTTP-level mocks`

### Wave 4 — M4: BUNDLED_PROVIDERS + runtime npm fallback

- [x] 18. `packages/core/provider/ai-sdk-loader`: BUNDLED_PROVIDERS map (8 packages) with lazy dynamic import
  What to do: `core/src/provider/ai-sdk-loader.ts`:
  ```ts
  const BUNDLED: Record<string, () => Promise<(opts: any) => LanguageModelV2Provider>> = {
    "@ai-sdk/openai":            () => import("@ai-sdk/openai").then(m => m.createOpenAI),
    "@ai-sdk/anthropic":         () => import("@ai-sdk/anthropic").then(m => m.createAnthropic),
    "@ai-sdk/google":            () => import("@ai-sdk/google").then(m => m.createGoogleGenerativeAI),
    "@ai-sdk/openai-compatible": () => import("@ai-sdk/openai-compatible").then(m => m.createOpenAICompatible),
    "@ai-sdk/mistral":           () => import("@ai-sdk/mistral").then(m => m.createMistral),
    "@ai-sdk/groq":              () => import("@ai-sdk/groq").then(m => m.createGroq),
    "@ai-sdk/xai":               () => import("@ai-sdk/xai").then(m => m.createXai),
    "@openrouter/ai-sdk-provider": () => import("@openrouter/ai-sdk-provider").then(m => m.createOpenRouter),
  };
  ```
  Add each as direct dep in `packages/core/package.json`. Add resolver `loadAiSdkProvider(npm: string, options): Promise<...>` that hits BUNDLED first.
  Must NOT do: NO hard pin of ai-sdk versions different from M2 (consistency); NO `eval()`-based dynamic require; NO global mutable state.
  Parallelization: Wave 4 | Blocked by: 10 | Blocks: 19, 21
  References: opencode `packages/opencode/src/provider/provider.ts:107-134`; package versions `packages/opencode/package.json:58-76` (use compatible versions).
  Acceptance criteria: each of 8 packages loadable; loaded factory returns object with `chat` / `responses` / `languageModel` methods (per ai-sdk shape).
  QA scenarios: happy: bun test loads each (evidence task-18); failure: pass an unknown npm name → returns `null`/throws caller-friendly error (sets up todo 19).
  Commit: Y | `feat(core): BUNDLED_PROVIDERS map of 8 ai-sdk packages with lazy import`

- [x] 19. `packages/core/npm.ts`: opencode-style runtime npm install + import-from-cache, using `process.execPath` self-spawn (NOT user-PATH `bun`), with openclaw-style PID+starttime sidecar lock
  What to do: Implement `npmAdd(pkg: string, registry?: string): Promise<{ entrypoint: string; version: string }>`. Cache dir = `~/.config/aio-proxy/cache/packages/<sanitize(pkg)>`. If `cache/<sanitize>/node_modules/<pkg>/package.json` exists → resolve entrypoint and return early. Else → acquire **PID+starttime sidecar lock** at `<cacheDir>/.aio-proxy-install.lock` (per openclaw `src/agents/session-write-lock.ts:524-546,928-944` pattern):
    - lock file content is `{ pid, createdAt, starttime, version: 1 }` written via `fs.writeFile(path, json, { flag: "wx" })`;
    - on EEXIST, read lock; if owner pid is dead OR pid recycled (process starttime differs) OR createdAt > 5min stale → atomic remove-if-unchanged then retry;
    - retry policy: 8 retries, factor 1.35, minTimeout 100ms, maxTimeout 2s, randomize true;
    - lock release in `finally` block deletes only if our pid still owns it.
  After lock acquired: `Bun.spawn([process.execPath, "add", pkg, "--no-save"], { cwd: cacheDir, env: { ...process.env, BUN_BE_BUN: "1", BUN_INSTALL_REGISTRY: registry ?? "https://registry.npmjs.org" } })`. The `BUN_BE_BUN=1` env tells our compiled binary to behave as the embedded bun runtime instead of the aio-proxy CLI; `process.execPath` resolves to the SAME binary (the only way that works without requiring user-PATH bun). Then in `loadAiSdkProvider`: BUNDLED miss → `npmAdd` → `await import(pathToFileURL(entrypoint))` → pick first export starting with `create`. **GATING**: `npmAdd` is NOT called automatically by `serve` (D-21''-revised); it is called only by (a) `aio-proxy provider install <pkg>`, (b) dashboard "Install" button (POST `/dashboard/providers/install` with risk-acknowledgment payload), or (c) e2e tests with `--yes` flag. Calling `npmAdd` from any other path is a programming error and throws.
  Must NOT do: NO `["bun", ...]` spawn (would require user-PATH bun, breaks standalone-binary promise); NO global `npm`/`pnpm` shell-out; NO writes outside the per-package cache dir; NO running `npmAdd` during `serve` startup; NO ignoring sidecar lock (race-on-first-install would corrupt cache); NO using `proper-lockfile` for THIS specific lock (we need PID+starttime owner metadata which `proper-lockfile` doesn't expose) — `proper-lockfile` IS used elsewhere (todo 22 db open, todo 21 config writes).
  Parallelization: Wave 4 | Blocked by: 18 | Blocks: 20, 21
  References: opencode `packages/core/src/npm.ts:74-79,124-129` and `packages/opencode/src/provider/provider.ts:1747-1763` (sst/opencode) for the import-from-file-URL pattern; openclaw `src/agents/session-write-lock.ts:524-546,928-944` and `src/infra/stale-lock-file.ts:34-45` (https://github.com/openclaw/openclaw) for the PID+starttime stale recovery shape; Bun docs https://bun.com/docs/bundler/executables for `BUN_BE_BUN`; plan's Bun research finding (Bun 1.3.14 cross-compile facts).
  Acceptance criteria: (a) **build-and-run spike**: build host-target binary (`bun build --compile --target=bun-<host> packages/cli/src/main.ts`), then in a sandbox HOME run `./dist/aio-proxy provider install @ai-sdk/cohere --yes`, then `./dist/aio-proxy provider list` confirms `@ai-sdk/cohere` installed at expected cache path; (b) integration test in non-binary mode also passes via `bun test packages/core/_test/npm.test.ts`; (c) concurrent-install test: 5 simultaneous `provider install @ai-sdk/cohere` invocations result in exactly ONE actual `bun add` HTTP exchange (others wait on lock then short-circuit because cache hit).
  QA scenarios: happy: build + spike script captures install transcript + `find ~/.config/aio-proxy/cache -name package.json` to `.omo/evidence/task-19-aio-proxy.txt`; failure: nonexistent package → `provider install bogus-not-real-pkg-xxxx` exits non-zero with bun stderr to `.omo/evidence/task-19-aio-proxy-fail.txt`; stale-lock test: drop a `.aio-proxy-install.lock` with `pid=999999` (definitely dead) + old `createdAt`, then run `provider install` → log shows lock recovered, install proceeds, capture to `.omo/evidence/task-19-aio-proxy-stale-lock.txt`.
  Commit: Y | `feat(core/npm): self-spawn (BUN_BE_BUN=1) + PID+starttime sidecar lock with stale recovery`

- [x] 20. `packages/core/provider/ai-sdk-runtime`: full ai-sdk provider with bundled+gated-fallback wired, plus `reasoning_content` wrapper for openai-compatible upstreams
  What to do: Replace todo 10's stub. `createAiSdkProvider({ npm, options, models }: AiSdkProviderSchema)` calls `loadAiSdkProvider(npm, options)` (which falls back to npmAdd when `npm` is bundled-or-installed; if missing → throw `ProviderNotInstalledError` with hint to run `aio-proxy provider install <pkg>` — `serve` does NOT auto-install, per D-21''-revised). Return a ProviderInstance whose `invoke()` builds `streamText({ model: provider(modelId), messages, tools, providerOptions })`. Default for `kind: "ai-sdk"` without explicit `npm`: `@ai-sdk/openai-compatible` with `options.baseURL`. **DeepSeek/openai-compatible reasoning wrapper**: when the provider is `@ai-sdk/openai-compatible` AND the upstream is in a known-reasoning allowlist (`["deepseek-reasoner","deepseek-r1*"]`) OR `provider.options.parseReasoningContent === true`, wrap the resulting LanguageModelV2 with a custom SSE delta parser that translates `delta.reasoning_content` → ai-sdk `reasoning` stream parts (per IR Fitness Contract row "DeepSeek `delta.reasoning_content`"). All ai-sdk runtime types are accessed only via `packages/core/src/ai-sdk-bridge/*` (the lone allowed importer of `ai` and `@ai-sdk/*`).
  Must NOT do: NO hot-swap of provider after creation (config reload always builds a new instance); NO bundling user options into the BUNDLED loader closure; NO importing `ai` or `@ai-sdk/*` outside `core/src/ai-sdk-bridge/*`; NO automatic `npmAdd` during `serve` (only via explicit `provider install` command).
  Parallelization: Wave 4 | Blocked by: 18, 19 | Blocks: 21, 24
  References: opencode `packages/opencode/src/provider/provider.ts:1409-1415,1660-1668` (sst/opencode); IR Fitness Contract row for DeepSeek `reasoning_content`; `@ai-sdk/openai-compatible` SSE parsing internals (https://github.com/vercel/ai/tree/main/packages/openai-compatible).
  Acceptance criteria: integration test: a config with `{ kind: "ai-sdk", npm: "@ai-sdk/groq", options: {...}, models: ["llama-3.3-70b-versatile"] }` works end-to-end with a mocked groq endpoint; a config referencing an uninstalled package fails fast with `ProviderNotInstalledError`; DeepSeek reasoning fixture round-trips reasoning text through the wrapper.
  QA scenarios: happy: e2e via OpenAI ingress → groq via ai-sdk captured to `.omo/evidence/task-20-aio-proxy.txt`; failure: config refers to `@ai-sdk/cohere` without prior install → `serve` boot succeeds (other providers still work), but a request to `cohere/<model>` returns 503 with `provider not installed; run aio-proxy provider install @ai-sdk/cohere`; capture to `.omo/evidence/task-20-aio-proxy-fail.txt`.
  Commit: Y | `feat(core/provider/ai-sdk): bundled+gated-fallback loader + reasoning_content wrapper`

- [x] 21. CLI `provider list --probe` + `provider install` + reload watcher with 4-stage validation pipeline + SSE backpressure
  What to do: Three parts.
    (a) **CLI** `aio-proxy provider list` reads dashboard/control route `GET /dashboard/providers`, prints table `id | kind | enabled | passthrough | last_status | last_latency`. With `--probe`, hits each provider with a small `{ messages: [{ role: "user", content: "ping" }], max_tokens: 1 }` and reports OK/FAIL. `aio-proxy provider install <pkg> [--yes]` prompts (or with --yes skips prompt) for npm package risk acknowledgment, then calls `core/npm.ts npmAdd`. `aio-proxy provider test <id>` is alias for `provider list --probe --filter <id>`.
    (b) **Reload pipeline** (4 stages, ALL-OR-NOTHING): `Bun.watch(configPath)` on change → STAGE 1: re-read file + zod parse → STAGE 2: build provider instances (`createApiProvider` / `createSubscriptionProvider` / `createAiSdkProvider` for each); STAGE 3: build router/alias map → STAGE 4: alias-collision validation (no two providers expose same alias unless one is fully-qualified-only). ANY stage failing → log structured error, KEEP serving OLD config, do NOT swap. On success → atomic swap of `Map<providerId, ProviderInstance>` and router via single ref assignment; broadcast `config.changed` SSE event with diff.
    (c) **SSE bounded queue** in `/dashboard/events`: per-connection async queue with cap 1000 events / 5MB; on overflow emit a final `events.dropped` event then close connection (client reconnects). `trace.delta` events are coalesced (≤ one delta per 50ms per trace_id) to bound rate.
  Must NOT do: NO blocking the event loop during reload; NO partial swap (atomic ref assignment is the ONLY swap mechanism); NO dropping in-flight streams (they keep their captured provider instance); NO unbounded SSE queue; NO auto-install on reload (config referencing a not-yet-installed pkg → reload SUCCEEDS but the affected provider returns 503 at request time per todo 20).
  Parallelization: Wave 4 | Blocked by: 20 | Blocks: 27 (dashboard hits these dashboard Hono RPC endpoints)
  References: opencode hot-reload via Effect Service; Bun.watch docs (https://bun.sh/docs/api/file-system#watching-files); Hono RPC docs `https://hono.dev/docs/guides/rpc#using-rpc-with-larger-applications`; Hono `streamSSE` docs (https://hono.dev/helpers/streaming).
  Acceptance criteria: integration: spawn server → request mid-flight → modify config (add a provider) → request completes against OLD config → new request uses NEW config; SSE event observed; alias-collision in new config → reload rejected, old serving continues, structured error logged; SSE backpressure test (slow consumer) → `events.dropped` then close, no memory blow-up.
  QA scenarios: happy: scripted scenario captures stdout/stderr to `.omo/evidence/task-21-aio-proxy.txt` with timestamped events; failure: write a config introducing alias collision → reload rejected, capture log + `aio-proxy provider list` (still shows old) to `.omo/evidence/task-21-aio-proxy-fail.txt`; SSE backpressure test captures memory + dropped count to `.omo/evidence/task-21-aio-proxy-sse.txt`.
  Commit: Y | `feat(cli+server): provider CLI + 4-stage reload pipeline + SSE bounded backpressure`

### Wave 5 — M5: GitHub Copilot subscription

- [ ] 22. `packages/auth-flows/store`: drizzle-backed auth table via `openDb()` + code-layer access isolation
  What to do:
  **Step 1 — schema (in core)**: define drizzle schema for `auth` table in `packages/core/src/db/schema/auth.ts` (matches the canonical schema in `## Database architecture`):
  ```ts
  export const auth = sqliteTable("auth", {
    vendor: text("vendor").notNull(),
    providerId: text("provider_id").notNull(),
    accountFingerprint: text("account_fingerprint"),    // nullable on first insert; required for subsequent CAS writes (D78/D91)
    payload: text("payload").notNull(),                  // opaque JSON, vendor-defined
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  }, (t) => [primaryKey({ columns: [t.vendor, t.providerId] })]);
  ```
  **Step 2 — migrations**: run `bun run build:migrations` (drizzle-kit generate) → produces a new SQL file under `packages/core/src/db/migrations/000N_add_auth.sql`. Run `bun packages/core/scripts/build-migrations-manifest.ts` to regenerate `packages/core/src/db/migrations.manifest.ts` (per `## Database architecture` section). Commit the SQL + the regenerated manifest.
  **Step 3 — store**: in `packages/auth-flows/src/store.ts` open the database via the SINGLE allowed entrypoint `openDb()` from `@aio-proxy/core/db` (per `## Database architecture` — NEVER call `new Database()` or `drizzle()` directly):
  ```ts
  import { openDb } from "@aio-proxy/core/db";
  import { auth } from "@aio-proxy/core/db/schema/auth";   // ONLY this file may import this schema
  const { db } = openDb();
  // exports: Auth.get / Auth.set / Auth.list / Auth.del
  ```
  `Auth.list()` returns `{ vendor, providerId, hasToken, expiresAt, accountLabel }[]` — NEVER the raw `payload`. `accountLabel` is derived from a vendor-provided `payload.account` field if present (default `null`).
  **Step 4 — isolation enforcement**: no custom root check script. Add unit/integration coverage in `packages/auth-flows` for the public `Auth` API, and rely on F1 mechanical grep to reject any import of `db/schema/auth` outside `packages/auth-flows/src/` plus any `SELECT * FROM auth` pattern in non-auth-flows source.
  **Step 5 — CAS + busy handling**: add `Auth.cas()` exactly as specified in `## Database architecture`. Request-path CAS uses `BEGIN IMMEDIATE` plus a temporary **350ms** busy timeout, restored to the default **5000ms** in `finally`. `SQLITE_BUSY` or `SQLITE_BUSY_*` becomes `AuthCasBusyError`, never `StaleProviderGenerationError`. Upper layers map `AuthCasBusyError` to retryable 503 plus localized retry text.
  Must NOT do: NO encryption-at-rest in MVP (keychain Phase 2); NO logging `payload` bytes (lint check via secret-pattern grep over CI logs); NO calling `new Database()` / `drizzle()` outside `packages/core/src/db/open-db.ts`; NO exposing raw `payload` over `Auth.list()` or dashboard Hono RPC API; NO importing `auth` schema outside `packages/auth-flows/src/`; NO bypassing migrations (table must come from a committed migration, not a runtime `CREATE TABLE`).
  Parallelization: Wave 5 | Blocked by: 4 (CLI HOME resolution), and an early `openDb()` lands in M2 alongside todos 8/9 — if `open-db.ts` doesn't exist yet it MUST be scaffolded as a sub-step of THIS todo (with traces/usage schemas as empty stubs to be filled in later waves) | Blocks: 23, 24
  References: opencode `packages/opencode/src/auth/index.ts:10,73-80` (sst/opencode) for the public API shape; drizzle Bun SQLite docs (https://orm.drizzle.team/docs/get-started/bun-sqlite-new); openclaw auth storage `src/agents/sessions/auth-storage.ts:157-166` (https://github.com/openclaw/openclaw) for proper-lockfile usage; this plan's `## Database architecture (single-entrypoint + binary-baked migrations)` section.
  Acceptance criteria:
  - Round-trip `set`/`get`/`del` for two vendor entries (e.g. `github-copilot:default` + `github-copilot:work`).
  - `Auth.list()` output regex-asserted to NOT contain `payload` / `access_token` / `refresh_token` / `Bearer` / `ghu_*` substrings.
  - `AIO_PROXY_HOME=$(mktemp -d) bun -e 'import { statSync } from "node:fs"; const mode = statSync(process.env.AIO_PROXY_HOME + "/aio-proxy.db").mode & 0o777; if (process.platform !== "win32" && mode !== 0o600) process.exit(1);'` exits 0 after first create.
  - `PRAGMA journal_mode` returns `wal`, `PRAGMA busy_timeout` returns `5000` on a normal `openDb({ readonly: true })` connection, and the dedicated `Auth.cas` test proves request-path CAS temporarily drops to **350ms** then restores **5000ms** in `finally`.
  QA scenarios: happy: `bun --filter '@aio-proxy/auth-flows' run test:unit > .omo/evidence/task-22-aio-proxy.txt 2>&1` plus `AIO_PROXY_HOME=$(mktemp -d) bun -e 'import { statSync } from "node:fs"; const p = process.env.AIO_PROXY_HOME + "/aio-proxy.db"; try { const mode = statSync(p).mode & 0o777; console.log(mode.toString(8), p); } catch (error) { console.error(error); process.exit(1); }' >> .omo/evidence/task-22-aio-proxy.txt`. Failure: corrupt the auth payload fixture so `Auth.list()` would expose `payload`/token fields, run the auth-flow test suite, capture the failing assertion to `.omo/evidence/task-22-aio-proxy-fail.txt`, then revert.
  Commit: Y | `feat(auth-flows): drizzle-backed auth table via openDb()`
  Must NOT do: NO encryption-at-rest in MVP (keychain Phase 2); NO logging payload bytes; NO leaving `aio-proxy.db` world-readable; NO exposing raw `payload` over `Auth.list()` or dashboard Hono RPC API; NO sharing the auth schema import outside `auth-flows`.
  Parallelization: Wave 5 | Blocked by: 4 (CLI HOME resolution), 8 (db/connect.ts comes with first drizzle migration during M2; if not, scaffold here) | Blocks: 23, 24
  References: opencode `packages/opencode/src/auth/index.ts:10,73-80` (sst/opencode) for the public API shape; drizzle docs for `bun-sqlite` driver (https://orm.drizzle.team/docs/get-started/bun-sqlite-new); openclaw auth storage `src/agents/sessions/auth-storage.ts:157-166` (https://github.com/openclaw/openclaw) for the proper-lockfile pattern around the underlying file.
  Acceptance criteria: round-trip `set`/`get`/`del` for two vendor entries; `Auth.list()` output asserted to NOT contain `payload` substring; tests run with `AIO_PROXY_HOME=$(mktemp -d)` (D98) and a Bun `fs.stat` check confirms mode `0600` on POSIX; `PRAGMA journal_mode` returns `wal`, `PRAGMA busy_timeout` returns `5000`; `account_fingerprint` column exists per `PRAGMA table_info(auth)`; **B4 stress test**: 50 parallel `Auth.cas` writers with mismatched expected fingerprints → exactly 1 succeeds, 49 throw `StaleProviderGenerationError`; **busy-path test**: concurrent lock contention on `BEGIN IMMEDIATE` yields `AuthCasBusyError`, not `StaleProviderGenerationError`, and a follow-up assertion proves the connection busy timeout is restored to `5000`. F1 covers code-layer import/query isolation with mechanical grep.
  QA scenarios: happy: `AIO_PROXY_HOME=$(mktemp -d) bun test packages/auth-flows/_test/store.test.ts > .omo/evidence/task-22-aio-proxy.txt 2>&1` plus `bun -e 'import { statSync } from "node:fs"; const p = process.env.AIO_PROXY_HOME + "/aio-proxy.db"; const mode = statSync(p).mode & 0o777; console.log(mode.toString(8), p);' >> .omo/evidence/task-22-aio-proxy.txt`. Failure 1 (redaction): corrupt the Auth.list implementation to include `payload`, run the store tests, capture the failing assertion to `.omo/evidence/task-22-aio-proxy-redaction-fail.txt`, then revert. Failure 2 (CAS race): the 50-parallel CAS test from acceptance — capture the winner count + auth row state to `.omo/evidence/task-22-aio-proxy-cas-race.txt`. Failure 3 (busy contention): deliberately hold a write transaction open longer than 350ms, run a second `Auth.cas`, capture `AuthCasBusyError` + restored timeout evidence to `.omo/evidence/task-22-aio-proxy-busy.txt`.
  Commit: Y | `feat(auth-flows): drizzle-backed auth table with CAS`

- [ ] 23. `packages/auth-flows/presets/github-copilot.ts`: device flow + endpoint token refresh
  What to do: Export `GithubCopilotPreset = { authFlow: { kind: "device-code", clientId: "Iv1.b507a08c87ecfe98", scope: "read:user" }, endpointTokenRefresh: ... }`. Implement `loginViaDeviceCode()`: POST to `https://github.com/login/device/code` → display `verification_uri` + `user_code` in stdout → poll `https://github.com/login/oauth/access_token` until token. Implement `getEndpointToken(refresh)`: GET `https://api.github.com/copilot_internal/v2/token` with `Authorization: token <refresh>`, returns `{ token, expires_at }`. Cache endpoint token in store; refresh ~5 min before expiry.
  Must NOT do: NO scraping VS Code's token storage; NO third-party "copilot proxy" intermediaries; NO printing tokens to stdout/logs.
  Parallelization: Wave 5 | Blocked by: 22 | Blocks: 25, 30
  References: opencode `packages/opencode/src/plugin/github-copilot/copilot.ts:222-336,160-178`; LiteLLM `litellm/llms/github_copilot/authenticator.py:216-356`.
  Acceptance criteria: integration test against MOCKED GitHub OAuth + MOCKED Copilot endpoint completes a full login flow with deterministic token strings.
  QA scenarios: happy: `AIO_PROXY_HOME=$(mktemp -d) bun test packages/auth-flows/_test/github-copilot.test.ts --reporter=spec > .omo/evidence/task-23-aio-proxy.txt 2>&1`; the test spins up mocked `/login/device/code`, `/login/oauth/access_token`, and `/copilot_internal/v2/token` endpoints, asserts the stored `Auth.list()` summary contains the account but no token payload, and prints the redacted store summary. Failure: configure the mocked OAuth poller to return `access_denied`, run `AIO_PROXY_HOME=$(mktemp -d) bun test packages/auth-flows/_test/github-copilot-denied.test.ts --reporter=spec > .omo/evidence/task-23-aio-proxy-denied.txt 2>&1`, expect non-zero flow result mapped to a clean `access_denied` user error and no token row written.
  Commit: Y | `feat(auth-flows/copilot): device-code OAuth + endpoint token refresh`

- [ ] 24. `packages/core/provider/subscription`: Copilot LanguageModel with single-flight refresh + CAS + provider generation (B-O5 fix)
  What to do: `core/src/provider/subscription/github-copilot.ts` exports `createCopilotLanguageModel({ providerId, accountFingerprint, generation })`.
  **Single-flight per `(providerId, generation)`**: keep a `Map<string, Promise<EndpointToken>>` keyed on `${providerId}:${generation}`. The `generation` is bumped by the reload pipeline (todo 21) every time the provider is reconstructed; a single-flight from the OLD generation cannot refresh into the NEW generation's bucket. The refresh helper MUST delete the map key in `finally`, whether refresh succeeds, fails, or throws, so a rejected refresh never poisons future retries. Forced-refresh-on-401 uses the exact same key derivation.
  **CAS token writes (B-O5)**: `Auth.set` for Copilot is forbidden — use `Auth.cas` (synchronous, mutator MUST also be synchronous):
  ```ts
  Auth.cas(vendor, providerId, expectedAccountFingerprint, (current) => {
    // Synchronous mutator. NO async/await — Bun transaction commits before async resolves.
    // The fingerprint check + atomic SQL CAS happens inside Auth.cas; mutator just produces the new payload.
    return {
      payload: { ...(current?.payload as object | undefined), endpoint_token, endpoint_expires_at },
      accountFingerprint: expectedAccountFingerprint,   // unchanged on refresh; rotated only on re-login
    };
  });
  // No await — Auth.cas is sync. StaleProviderGenerationError is thrown synchronously if CAS rejects.
  ```
  Where `accountFingerprint` is `sha256(access_token + githubLogin)` computed at provider construction. `Auth.cas()` is added to the auth-flows store (todo 22 amendment): runs the read+write inside a SQLite transaction with the fingerprint check.
  **In-flight survival semantics**: a Copilot request that started under generation N keeps using N's provider instance and N's token cache; if it triggers a refresh and CAS rejects (because the user re-logged or reloaded with a new account), the request fails with the localized `error_provider_token_invalidated` message and ZERO writes to the auth row. If CAS hits `AuthCasBusyError`, the request maps that to a retryable 503 plus localized retry text, never to `StaleProviderGenerationError`.
  **HTTP layer**: uses `@ai-sdk/openai-compatible`'s `createOpenAICompatible` (or opencode's lowercase variant if the public API doesn't expose what we need; spike in this todo) configured with `baseURL: "https://api.githubcopilot.com"`, custom `fetch` that calls the single-flighted `getEndpointToken()` to inject `Authorization: Bearer <endpoint_token>`, `Editor-Version: aio-proxy/<v>`, `Editor-Plugin-Version: aio-proxy/<v>`, `Copilot-Integration-Id: vscode-chat`. On upstream 401 → ONE refresh+retry under single-flight; second 401 → localized `error_provider_relogin_required` (`aio-proxy provider login github-copilot`).
  Must NOT do: NO modifying global fetch; NO sharing single-flight map across providers OR generations; NO unbounded retry on 401 (max 1); NO bypassing CAS (direct `Auth.set` for Copilot is forbidden; F1 greps subscription providers for it); NO storing access/refresh tokens in memory beyond the single-flight promise's lifetime.
  Parallelization: Wave 5 | Blocked by: 22 (Auth.cas helper), 23 (device flow → store) | Blocks: 25
  References: opencode `packages/core/src/github-copilot/copilot-provider.ts:52-74` (sst/opencode) for `createOpenaiCompatible` shape; `packages/opencode/src/provider/provider.ts:130-133` for BUNDLED route registration; LiteLLM `litellm/llms/github_copilot/authenticator.py:266-356` for refresh semantics; this plan's `## Database architecture` for transaction usage; D52 single-flight + D58 provider immutability.
  Acceptance criteria:
  - Integration test against a mocked Copilot endpoint streams 3 chunks correctly with expected auth headers asserted by the mock.
  - **Concurrent-refresh test**: `Promise.all` of 50 expired-token requests under SAME generation → exactly 1 refresh HTTP call (verified via mock counter), and the single-flight map is empty again after completion.
  - **Cross-generation race test (B-O5 regression)**: simulate a reload mid-flight: gen=1 has 30 in-flight requests with expired token; reload bumps to gen=2 with a different `accountFingerprint`; assert (a) gen=1 in-flight requests fail cleanly with `error_provider_token_invalidated` (CAS rejected), (b) gen=2's auth row is NOT corrupted by gen=1, (c) a fresh gen=2 request succeeds with gen=2's token.
  - 401-retry test: upstream 401 → 1 refresh + 1 retry → 200; second consecutive 401 → localized re-login error. A failed forced refresh must clear the single-flight key so the next request can attempt a fresh refresh.
  QA scenarios: happy: `bun test packages/core/_test/provider/github-copilot.test.ts > .omo/evidence/task-24-aio-proxy.txt 2>&1` including the concurrent-refresh + cross-generation assertions. Failure: simulate two consecutive upstream 401s → error envelope with `error_provider_relogin_required` localized message captured to `.omo/evidence/task-24-aio-proxy-fail.txt`. Race-regression: capture the cross-generation race test's auth-row state assertions to `.omo/evidence/task-24-aio-proxy-race.txt`.
  Commit: Y | `feat(core/provider): Copilot LanguageModel with single-flight + CAS + generation guard`

- [ ] 25. CLI `provider login github-copilot` + interactive init wizard with ProviderPreset abstraction + atomic write
  What to do:
    (a) **ProviderPreset registry** in `packages/auth-flows/presets/index.ts`: each vendor exports `ProviderPreset = { vendor: string; displayName: string; kind: "api"|"subscription"|"ai-sdk"; protocol?: ...; npm?: string; needs: ("apiKey"|"oauth"|"baseURL")[]; defaultModels: string[]; loginFlow?: () => Promise<...> }`. Ship 7 presets: `openai`, `anthropic`, `google` (`api` kind), `github-copilot` (`subscription`), `openrouter`, `mistral`, `openai-compatible-custom` (`ai-sdk` kind). Wizard's UX is in preset terms ("OpenAI" / "Copilot" / etc); the data-model `kind` is internal.
    (b) **`aio-proxy provider login github-copilot`** runs the device flow (todo 23), persists to the SQLite `auth` table, and (if not already in config) appends a `{ id: "copilot", kind: "subscription", vendor: "github-copilot", enabled: true, models: ["gpt-4o","claude-sonnet-4-5"] }` entry to `config.jsonc` via the same atomic-write mechanism as (c).
    (c) **First-run wizard**: when `config.jsonc` is absent on `serve`, branch on `process.stdin.isTTY`:
      - **TTY**: prompt provider checklist (multi-select from preset registry display names); for each selected preset, prompt the `needs` (api key / OAuth / baseURL); accumulate the proposed config object IN MEMORY ONLY; intercept SIGINT to clean up and exit 130 with no disk writes; on completion write to `config.jsonc.tmp` then `rename` (atomic); ALL prompts mask secret input (no echo, never logged); then continue to `serve` boot.
      - **non-TTY**: write the empty config `{ server: {...}, providers: [] }` atomically and log "config bootstrapped — edit ~/.config/aio-proxy/config.jsonc or open dashboard at http://127.0.0.1:22079".
  Must NOT do: NO partial config persisted on Ctrl-C; NO secret echoed to stdout/logs; NO non-TTY prompts; NO storing api keys in plaintext when `--use-keychain` (Phase 2 — flag accepted but no-op with warning); NO blocking `serve` boot if wizard exits cleanly with no providers selected (boot proceeds with empty providers).
  Parallelization: Wave 5 | Blocked by: 22, 23 | Blocks: 27 (dashboard "Add provider" reuses preset registry)
  References: opencode CLI provider preset patterns; `@inquirer/prompts` docs for SIGINT-safe prompts (https://github.com/SBoudrias/Inquirer.js).
  Acceptance criteria: e2e in a fresh `$HOME`: (1) run `serve` in TTY mode → wizard prompts → select Copilot → mocked OAuth completes → atomic write asserts no `.tmp` left → server boots with Copilot provider → request via `gpt-4o` alias works; (2) Ctrl-C mid-prompt → no `config.jsonc` or `config.jsonc.tmp` on disk; (3) non-TTY (`/dev/null < ...`) → empty config written, hint logged; (4) spurious key paste echo → asserted absent in stdout transcript.
  QA scenarios: happy: scripted PTY test captures full transcript to `.omo/evidence/task-25-aio-proxy.txt`, plus `find ~/.config/aio-proxy -type f | xargs ls -la` showing only `config.jsonc`+`aio-proxy.db`; failure: Ctrl-C scenario captures empty-dir listing to `.omo/evidence/task-25-aio-proxy-fail.txt`; secret-leak failure case: any echo of the typed api key in transcript fails the test.
  Commit: Y | `feat(cli): ProviderPreset registry + interactive init wizard with atomic write`

### Wave 6 — M6: Dashboard

- [ ] 26. `packages/dashboard`: shadcn preset init + Vite + React 19 + Tailwind v4 + TanStack family skeleton (kebab-case files; preset baseline committed)
  What to do:
  **Step 1 — initial scaffold (run ONCE during this todo's first commit; outputs become the in-repo baseline):**
  From `packages/dashboard/`: `bunx --bun shadcn@latest init --preset b6a2WHJKc --template vite --pointer` (D71 — user's pre-configured theme preset). Capture the resolved outputs into the repo:
    - `packages/dashboard/components.json` (shadcn config)
    - `packages/dashboard/src/index.css` (Tailwind v4 directives + theme tokens generated by the preset)
    - `packages/dashboard/src/lib/utils.ts` (shadcn `cn()` helper)
    - any baseline shadcn components that the preset auto-installs (typically `button`, `card`, `dialog`, `input` under `src/components/ui/`)
    - `packages/dashboard/tailwind.config` is NOT generated in v4 (Tailwind v4 has no JS config); the theme lives entirely in `src/index.css` via `@theme { ... }` blocks.
  Commit ALL of these. **From this point forward the local files are the source of truth — todo 26's acceptance does NOT depend on the remote preset id being live or reproducible.** Provenance is recorded in a SEPARATE markdown file `packages/dashboard/shadcn-provenance.md` (NOT inside `components.json`, which is strict JSON and cannot legally hold comments) with this content:
  ```md
  # shadcn preset provenance
  - Generated from shadcn preset `b6a2WHJKc` on YYYY-MM-DD via `bunx --bun shadcn@latest init --preset b6a2WHJKc --template vite --pointer`.
  - The local files (`components.json`, `src/index.css`, `src/lib/utils.ts`, `src/components/ui/*.tsx`) are the canonical source from this point forward.
  - Re-run the preset command **only** when intentionally re-theming; expect a manual diff review afterward (the preset may have evolved upstream).
  - Future shadcn component additions: `bunx --bun shadcn@latest add <component> -c packages/dashboard`. The local `components.json` + `src/index.css` are sufficient — the preset id is NOT needed.
  ```

  **Step 2 — TanStack Router with kebab-case codegen output:**
  Install `@tanstack/router-plugin` (per `## Dependencies` table). Configure `vite.config.ts`:
  ```ts
  import { defineConfig } from "vite";
  import react from "@vitejs/plugin-react";
  import tailwindcss from "@tailwindcss/vite";
  import { tanstackRouter } from "@tanstack/router-plugin/vite";
  export default defineConfig({
    plugins: [
      tanstackRouter({
        target: "react",
        routesDirectory: "src/routes",
        generatedRouteTree: "src/route-tree.gen.ts",  // D76 kebab-case
      }),
      react(),
      tailwindcss(),
    ],
    base: "/",
    build: { outDir: "dist" },
  });
  ```
  File-based routing under `packages/dashboard/src/routes/` (each file kebab-case **except `__root.tsx` which is a TanStack Router framework convention — explicitly allowed by D76**): `__root.tsx`, `index.tsx`, `providers.tsx`, `models.tsx`, `traces.tsx`, `usage.tsx`, `settings.tsx`. Each route is a stub returning `<div>{m.dashboard_routes_<name>_placeholder()}</div>` (replace `<name>` with the route's namespace per D77 paraglide convention; e.g. `m.dashboard_routes_providers_placeholder()`). The router plugin generates `src/route-tree.gen.ts` automatically; add it to `.gitignore` (don't commit codegen) and add an explicit Biome `ignore` for it.

  **Step 3 — TanStack Query + i18n wiring:**
  Install the rest of the TanStack family (`@tanstack/react-query`, `@tanstack/react-table`, `@tanstack/react-form`, `@tanstack/react-virtual`). In `src/main.tsx` wrap with `<QueryClientProvider>`. Create `src/i18n.ts` that re-exports `m` from `@aio-proxy/i18n` (`export { m } from "@aio-proxy/i18n"`) AND defines a tiny `useLocale()` hook reading from `localStorage["aio-proxy.locale"]` then `navigator.language` then `"en"`, calling `setLocale()` from `@aio-proxy/i18n` on change. Components import: `import { m } from "@/i18n"` (or directly from `@aio-proxy/i18n`).

  **Step 4 — verify shadcn pipeline:**
  `src/routes/index.tsx` imports `<Button>` from `@/components/ui/button` and renders `<Button>{m.dashboard_routes_index_placeholder()}</Button>` to verify the shadcn + paraglide pipeline end-to-end.

  Must NOT do: NO Next.js; NO React server components; NO redux/zustand; NO chat playground; NO `<I18nButton>` / `<I18nDialog>` wrapper twins (use direct `m.*()` calls; F1 samples dashboard text for obvious English literals); NO PascalCase file names except framework conventions explicitly allowed in D76's exceptions list (`__root.tsx` for TanStack Router); NO manual edits to `src/index.css`'s preset-generated `@theme` block (theme changes are a separate todo with explicit approval); NO `bun create vite` or any non-shadcn-preset scaffolder; NO writing comments inside `components.json` (it's strict JSON — provenance goes in `packages/dashboard/shadcn-provenance.md` instead per M2 fix); NO `t(...)` legacy calls (D77 paraglide-only); NO `import * as m from ...; m.m.foo()` double-namespace (B1 fix — i18n package re-exports messages directly).

  Parallelization: Wave 6 | Blocked by: 1 (workspace + deps), 35 (i18n paraglide package) | Blocks: 27, 28

  References: shadcn docs (https://ui.shadcn.com/docs/installation/vite); React 19 / Tailwind v4 / TanStack family per `## Dependencies` table; user-provided preset code `b6a2WHJKc` (recorded as provenance); TanStack Router file-based routing docs (https://tanstack.com/router/latest/docs/framework/react/guide/file-based-routing); plan section `## File naming convention (D76)`.

  Acceptance criteria:
  - `bun --filter '@aio-proxy/dashboard' run build` produces `dist/index.html` + assets; an inline `bun -e`/Node `zlib.gzipSync` command computes total gzipped JS+CSS size and enforces **2.5 MB hard cap** with **1.2 MB warning threshold**. The command walks `packages/dashboard/dist/**`, includes only `.js` and `.css`, and prints per-file + total byte counts. (1.2 MB hard cap was over-tight given React 19 + 5 TanStack packages + Tailwind v4 + shadcn baseline; lifted to 2.5 MB hard, 1.2 MB warning per Oracle v4 #10 / M4.)
  - All committed files under `packages/dashboard/src/**` and `packages/dashboard/components.json` exist (preset baseline locked into the repo).
  - `packages/dashboard/shadcn-provenance.md` exists with the documented provenance content.
  - `cat packages/dashboard/components.json | bunx jsonlint -c -` exits 0 (proves JSON is strict-valid; no comments inside).
  - `find packages/dashboard/src -type f | grep -vE '\.gen\.ts$|__root\.tsx$' | grep -E '[A-Z]'` returns nothing (kebab-case enforced; `__root.tsx` is the only allowed framework exception per D76).
  - `grep -q 'route-tree.gen.ts' .gitignore && grep -q 'packages/i18n/src/paraglide/' .gitignore` (codegen not committed).
  - **Future-add smoke**: `bunx --bun shadcn@latest add accordion -c packages/dashboard --dry-run` exits 0 and reports it WOULD create `src/components/ui/accordion.tsx` — proving the local `components.json` baseline is sufficient without the original preset id (D86 + Oracle 13 fix).
  - `grep -E '"(react-i18next|i18next|lingui|@tanstack/db)"' packages/dashboard/package.json` returns nothing.

  QA scenarios: happy: `bun --filter '@aio-proxy/dashboard' run build && bun --filter '@aio-proxy/dashboard' run preview &` then `curl -s http://127.0.0.1:4173/ | grep -q '<div id="root">'`; tee output to `.omo/evidence/task-26-aio-proxy.txt`; append the inline gzipped JS+CSS size command output and the future-add smoke `bunx --bun shadcn@latest add accordion -c packages/dashboard --dry-run`. Failure: introduce a TS error in `src/routes/providers.tsx` → `bun run build:dashboard` exits non-zero; capture to `.omo/evidence/task-26-aio-proxy-fail.txt`. Resilience scenario: temporarily delete `packages/dashboard/components.json`, run `bun run build:dashboard` → still succeeds because the rest of the baseline (CSS theme, `lib/utils.ts`, components) is sufficient; restore `components.json` from git; capture to `.omo/evidence/task-26-aio-proxy-resilience.txt`.

  Commit: Y | `feat(dashboard): shadcn preset b6a2WHJKc baseline + Vite + React 19 + TanStack + kebab-case files`

- [ ] 27. Dashboard pages: Providers (CRUD with form-per-preset) + Models (alias editor) + Trace (live SSE) + Usage (chart) + Settings; models.dev autocomplete; auth dashboard GET only; "Install" button → npmAdd; Hono RPC client; SSE backpressure-aware
  What to do: Implement 5 routes using a typed Hono RPC client created from `hc<AppType>()` imported from `@aio-proxy/server`; server side adds these dashboard Hono RPC endpoints in the same todo:
    - `GET /dashboard/providers` (returns list with derived `passthrough: boolean` flag); `POST /dashboard/providers` (validates preset → writes via reload pipeline); `PUT /dashboard/providers/:id`; `DELETE /dashboard/providers/:id`.
    - `GET /dashboard/models` (resolved alias table with origin provider).
    - `GET /dashboard/events` SSE for trace updates (subscribes; client uses `EventSource` with reconnect; respects `events.dropped` event by re-fetching last N traces over `GET /dashboard/traces`).
    - `GET /dashboard/traces?since=&limit=&trace_id=` (paged; body redaction already applied at write time per Must-have #6).
    - `GET /dashboard/usage?since=&groupBy=` for chart (rolls up `usage` table).
    - `GET /dashboard/auth` (returns ONLY `{ vendor, providerId, hasToken, expiresAt, accountLabel }[]` via `auth-flows.Auth.list()` — never raw payload).
    - `POST /dashboard/providers/install` `{ npm }` → calls `core/npm.ts npmAdd` (gated by per-session confirm dialog on dashboard; user must check "I trust this package's postinstall scripts" — D-21''-revised).
    - `POST /dashboard/providers/login` `{ vendor, providerId }` → kicks the corresponding `ProviderPreset.loginFlow` (Copilot device flow); dashboard polls progress over SSE.
  Provider form auto-completes model ids from cached `models_dev_cache` table (hydrated on startup from `https://models.dev/api.json` with 24h TTL; offline → bundled fallback shipped in binary). Trace page renders a live-updating list with detail drawer (request body, response body, events timeline, IR Fitness fields if present). Keep these route definitions in chained `.route()` composition so `export type AppType = typeof routes` remains precise for larger-app Hono RPC; if TypeScript slows down, emit precompiled declaration types rather than weakening `AppType`.
  Must NOT do: NO chat playground; NO writing or returning raw `auth.payload` (must always go through `Auth.list()` API which strips); NO model-cost calculator (Phase 2); NO bulk-edit UI (Phase 2); NO `SELECT * FROM auth` from any handler (F1 mechanical grep enforces); NO unconfirmed `npmAdd` from dashboard (always require explicit user click on "Install" with risk acknowledgment); NO using models.dev capability flags to gate routing/passthrough — it's autocomplete-only (D32 constraint); NO hand-written `fetch("/dashboard/...")` wrappers for dashboard CRUD (use typed Hono RPC client).
  Parallelization: Wave 6 | Blocked by: 21, 26 | Blocks: 28
  References: opencode auth + provider editing UX patterns; Hono RPC docs `https://hono.dev/docs/guides/rpc#using-rpc-with-larger-applications`; this plan's `## IR Fitness Contract` (dashboard trace drawer surfaces these); models.dev API shape (https://models.dev/api.json).
  Acceptance criteria: Playwright e2e (headless): (1) open dashboard → click "Add Provider" → select OpenAI preset → enter API key → save → request via curl → trace appears within 1s; usage chart shows the request; (2) click "Install" on `@ai-sdk/cohere` → confirm dialog → install completes → provider can be configured; (3) `GET /dashboard/auth` response asserted to NOT contain `payload` substring; (4) Token-pattern regex grep over all `/dashboard/*` responses asserts no `ghu_*` / `Bearer .*` / `sk-*` leakage; (5) `bun run check` proves dashboard calls compile through `hc<AppType>()` and rejects a deliberately misspelled dashboard endpoint in the failure scenario.
  QA scenarios: happy: full Playwright run captures video to `.omo/evidence/task-27-aio-proxy.webm` and stdout to `.omo/evidence/task-27-aio-proxy.txt`; failure: invalid api key → form rejects with backend zod error rendered inline, captured to `.omo/evidence/task-27-aio-proxy-fail.txt`.
  Commit: Y | `feat(dashboard): provider CRUD + alias + trace + usage + install button + auth-safe dashboard`

- [ ] 28. Embed dashboard `dist/` into server via `Bun.embeddedFiles` and serve at `:22079`
  What to do: In `packages/cli/build.ts`, the `Bun.build({ compile: ... })` call also includes `packages/dashboard/dist/**/*` via `import.meta.glob` + `with { type: "file" }` patterns for index.html / assets. Server reads them via `Bun.embeddedFiles` and serves on a second `Bun.serve` listening on `:22079`. CLI flag `--no-dashboard` disables. `aio-proxy dashboard` command checks `:22078/health`, spawns serve if absent, then `open http://127.0.0.1:22079`.
  Must NOT do: NO read from disk at runtime for dashboard assets (they MUST be embedded); NO HTTP redirect; NO dual-process model (same process, second port).
  Parallelization: Wave 6 | Blocked by: 27 | Blocks: 29
  References: Bun docs `executables.mdx:675-928`; `Bun.embeddedFiles`.
  Acceptance criteria: a built binary serves dashboard correctly even when run from `/tmp` with no node_modules nearby.
  QA scenarios: happy: `bun run build:dashboard && bun run build:binary && host_bin=$(find dist -maxdepth 1 -type f -perm -111 -name 'aio-proxy*' | head -1) && test -n "$host_bin" && bin_dir=$(mktemp -d) && cp "$host_bin" "$bin_dir/aio-proxy" && chmod +x "$bin_dir/aio-proxy" && (cd /tmp && AIO_PROXY_HOME=$(mktemp -d) "$bin_dir/aio-proxy" serve --dashboard --port 22078 > /tmp/aio-proxy-dashboard.log 2>&1 & echo $! > /tmp/aio-proxy-dashboard.pid) && sleep 2 && curl -fsS http://127.0.0.1:22079/ | tee .omo/evidence/task-28-aio-proxy.txt | grep -q '<div id="root">' && kill "$(cat /tmp/aio-proxy-dashboard.pid)" && cat /tmp/aio-proxy-dashboard.log >> .omo/evidence/task-28-aio-proxy.txt`; expected result: the copied binary serves embedded dashboard HTML from `/tmp` without `node_modules`. Failure: move the binary into a read-only temp dir (`chmod 0555 "$bin_dir"`), run the same command with a writable `AIO_PROXY_HOME`, then `curl -fsS http://127.0.0.1:22079/` still returns embedded HTML and no runtime dashboard asset reads appear in logs; capture to `.omo/evidence/task-28-aio-proxy-readonly.txt`.
  Commit: Y | `feat(server+cli): embed dashboard dist via Bun.embeddedFiles + serve on :22079`

### Wave 7 — M7: cross-platform binary + release pipeline

- [ ] 29. `packages/cli/build.ts`: programmatic `Bun.build` for all 5 targets, with prebuild assertions + size cap report
  What to do: A Bun script that:
  **Step 0 — prebuild assertions** (B5 fix): the script's first action is to assert these files exist; if any is missing, FAIL with the unified format `"Missing <path>. This script expects prebuild artifacts. Normally invoked via \`bun run build:binary\` (which chains i18n:compile → build:dashboard → this script). To recover, run: <hint>."` and exit non-zero. Required artifacts:
    - `packages/i18n/src/paraglide/messages.js` AND `messages.d.ts` (hint: `bun run i18n:compile`)
    - `packages/dashboard/src/route-tree.gen.ts` (hint: `bun run build:dashboard`)
    - `packages/dashboard/dist/index.html` (hint: `bun run build:dashboard`)
    - `packages/core/src/db/migrations.manifest.ts` (hint: `bun run build:migrations && bun packages/core/scripts/build-migrations-manifest.ts`)
  **Step 1 — matrix build**: loop `[bun-darwin-arm64, bun-darwin-x64, bun-linux-x64-modern, bun-linux-arm64, bun-windows-x64]` and call `Bun.build({ entrypoints: ["packages/cli/src/main.ts"], compile: { target, autoloadPackageJson: true, outfile: \`dist/aio-proxy-\${target}/aio-proxy\${target.includes("windows")?".exe":""}\` }, external: ["node-gyp"] })`.
  **Step 2 — host-target smoke**: on the host-matching target only, exec `./dist/aio-proxy-<host>/aio-proxy --version`. Cross-compiled targets are uploaded as-is.
  **Step 3 — size cap report (D87)**: for each produced binary, compute total size + top-20 largest embedded assets via `bun build --compile --analyze` or a manual stat walk. Write a report to `dist/size-report.txt` with one section per target: total bytes, top 20 assets (path + size), sourcemap presence (must be FALSE in release), embedded-dashboard total, paraglide bundle slice (a heuristic grep for `cli_serve_description` etc. — log warning if any unused-in-CLI message contributes >5KB). FAIL if any target exceeds 150 MB hard cap; WARN if ≥ 140 MB.
  Must NOT do: NO bundling user node_modules at build time (only our deps); NO sourcemaps in release builds (Phase 2 with `--sourcemaps`); NO `--no-bundle` (not supported with --compile); NO running `Bun.build` if Step 0 assertions fail; NO uploading binaries that exceeded the size cap.
  Parallelization: Wave 7 | Blocked by: 28 | Blocks: 30, 31
  References: opencode `packages/opencode/script/build.ts:53-184` (sst/opencode); codebase-foundation/codebase-cli matrix workflow; D87 size cap.
  Acceptance criteria: 5 binaries produced under `dist/`; each between 90 MB and 150 MB; native target executes `--version` successfully; `dist/size-report.txt` exists with all 5 targets reported; no target ≥ 150 MB.
  QA scenarios: happy: matrix build → tee size report + checksums to `.omo/evidence/task-29-aio-proxy.txt`. Failure 1 (missing prebuild): `rm -rf packages/dashboard/dist`, run `bun packages/cli/build.ts`, capture non-zero exit + the hint to `.omo/evidence/task-29-aio-proxy-missing-prebuild.txt`. Failure 2 (size cap): force-include a 200 MB blob into the bundle (e.g. via `with { type: "file" }` of a fake fixture), run build, capture the cap-violation message to `.omo/evidence/task-29-aio-proxy-size-cap.txt`, then revert.
  Commit: Y | `feat(cli/build): 5-target binary build with prebuild assertions + size cap report`

- [ ] 30. `packages/cli/script/publish.ts`: npm meta `aio-proxy-ai` + per-platform sub-packages with diagnostic shim (opencode pattern)
  What to do: Script generates one npm package per built binary: `aio-proxy-darwin-arm64`, `aio-proxy-darwin-x64`, `aio-proxy-linux-x64-modern`, `aio-proxy-linux-arm64`, `aio-proxy-windows-x64`, each with `bin: { aio-proxy: "./bin/aio-proxy[.exe]" }`, narrow `os` + `cpu` (and `libc: ["glibc"|"musl"]` where applicable). Then generate `aio-proxy-ai` meta with `optionalDependencies` referencing those, and a tiny JS shim at `bin/aio-proxy.js` that:
    1. detects `process.platform` + `process.arch` + libc (via `process.report?.getReport().header?.glibcVersionRuntime` heuristic);
    2. resolves the right sub-package's binary path via `require.resolve("aio-proxy-<platform>/bin/aio-proxy")`;
    3. on resolve failure, prints a multi-line diagnostic: detected platform/arch, expected sub-package name, three remediation commands (`npm install --include=optional aio-proxy-ai`, `npm install -g aio-proxy-<platform>`, GitHub Releases download URL `https://github.com/<org>/aio-proxy/releases/latest/download/aio-proxy-<platform>.tar.gz`);
    4. on success, `child_process.spawn` the resolved binary with `process.argv.slice(2)` + inherit stdio + propagate exit code.
  **Pre-decided**: npm publish target is `npmjs.org` (no private registry); test channel uses `next` dist-tag; stable uses `latest`. Repo URL is set in `package.json:repository` to `<org>/aio-proxy` (org placeholder filled in todo 33).
  Must NOT do: NO publishing source TS to npm; NO sourcemaps in release packages; NO publishing without an explicit `--tag` flag (defaults to dry-run if missing); NO silent fallback to a different binary on platform mismatch — always print the diagnostic.
  Parallelization: Wave 7 | Blocked by: 29 | Blocks: 31
  References: opencode `packages/opencode/script/publish.ts:22-69` (sst/opencode); npm `optionalDependencies` semantics; live `npm view opencode-ai` shape.
  Acceptance criteria: dry-run (`npm publish --dry-run`) succeeds for all 6 publishable packages; on a real publish to npmjs against dist-tag `next`, `npm i -g aio-proxy-ai@next` then `aio-proxy --version` works on the host platform; **negative**: `npm i -g aio-proxy-ai@next --no-optional` then `aio-proxy --version` prints the multi-line diagnostic AND exits with code 2 (not crash).
  QA scenarios: happy: dry-run captures `npm publish --dry-run --json` output to `.omo/evidence/task-30-aio-proxy.txt`; failure: simulate platform-mismatch by deleting the resolved sub-package post-install, run `aio-proxy`, capture diagnostic to `.omo/evidence/task-30-aio-proxy-fail.txt`, assert it contains all 3 remediation hints.
  Commit: Y | `feat(cli/publish): npm meta + per-platform subpackages with diagnostic shim`

- [ ] 31. GitHub Releases workflow + `install.sh` (curl|sh) + `install.ps1`, install host pre-decided
  What to do: `.github/workflows/release.yml` triggered by tag `v*`. Job matrix builds 5 targets (using setup-bun@v2 + run `packages/cli/build.ts`); uploads `aio-proxy-<target>.tar.gz` (or `.zip` for windows) + `aio-proxy-<target>.sha256` to GitHub Release; runs `publish.ts` to npm (dist-tag = `next` for `-rc` / `-beta` / `-alpha` versions, `latest` for stable). Add `scripts/install.sh` (POSIX, detects `uname -s`/`uname -m`/libc → curls correct `tar.gz` from GH Release → verifies sha256 → unpacks to `~/.local/bin/aio-proxy` + chmod 0755) and `scripts/install.ps1` (Windows: same idea, unpacks zip to `%USERPROFILE%\.aio-proxy\`). `install.sh` accepts `--version <tag>` to pin and `--prefix <dir>` to override target. **Install host (pre-decided)**: scripts are served directly from `https://raw.githubusercontent.com/<org>/aio-proxy/main/scripts/install.sh` — NO custom domain in MVP (keeps Phase-1 release infra zero-cost). README's curl one-liner uses this URL.
    On macOS the script prints (not auto-runs) the unquarantine recipe: `xattr -dr com.apple.quarantine ~/.local/bin/aio-proxy` plus a "or open System Settings → Privacy & Security → Allow Anyway after first launch" instruction. Notarization is Phase 2.
    GitHub Actions secrets needed: `NPM_TOKEN` (for npm publish, scope: `automation`), `GITHUB_TOKEN` (already provisioned). No Apple Developer ID secret in MVP.
  Must NOT do: NO unsigned-binary auto-execution on macOS without warning; NO HTTP-only download URLs; NO `eval $(curl ...)`-style installer chaining; NO uploading SDK source to release artifacts; NO assuming a custom domain exists.
  Parallelization: Wave 7 | Blocked by: 30 | Blocks: 32
  References: codebase-foundation/codebase-cli `.github/workflows/build-binaries.yml`; Bun docs `bun.sh/docs/bundler/executables` notes on codesign; opencode release workflow `.github/workflows/publish.yml:89-98` (sst/opencode).
  Acceptance criteria: pushing tag `v0.1.0-rc.1` triggers the workflow → 5 release artifacts + sha256 + npm publish with dist-tag `next` → `npm view aio-proxy-ai@next` lists the version → `curl -fsSL https://raw.githubusercontent.com/<org>/aio-proxy/main/scripts/install.sh | sh -s -- --version v0.1.0-rc.1` installs and `aio-proxy --version` runs on a clean Linux container.
  QA scenarios: happy: full release dry-run on a fork captures workflow log + final `aio-proxy --version` output to `.omo/evidence/task-31-aio-proxy.txt`; failure: missing `NPM_TOKEN` secret → workflow fails on `npm publish` step with clear error; capture to `.omo/evidence/task-31-aio-proxy-fail.txt`.
  Commit: Y | `feat(release): GitHub Releases workflow + install.sh/install.ps1 (raw GH host)`

### Wave 8 — M8: e2e + first release

- [ ] 32. Full e2e test suite using each protocol's official client SDK against HTTP-level mock upstreams; IR Fitness regression
  What to do: `tests/e2e/` runs against a binary-built `aio-proxy serve` in a child process. **Upstream is always an HTTP-level mock** (Bun.serve fake speaking the wire protocol) — never a library-level stub. Suites:
    (a) `openai` SDK → all 4 ingress combos through openai-compatible api provider (1 passthrough + 3 cross).
    (b) `@anthropic-ai/sdk` → 4 combos (1 passthrough + 3 cross).
    (c) `@google/genai` → 4 combos (1 passthrough + 3 cross).
    (d) Copilot subscription smoke (skipped in CI without `COPILOT_TEST_TOKEN` env, runs locally on dev's machine).
    (e) **IR Fitness regression**: for each row in the `## IR Fitness Contract` table, at least one e2e scenario sends a feature-bearing payload (cache_control, thinking, reasoning_effort, inlineData, reasoning_content) and asserts (i) the SDK consumed without error, (ii) the upstream mock received the expected wire shape (raw body comparison vs golden fixture from `tests/e2e/fixtures/<feature>.json`), (iii) cross-protocol drops are recorded in trace as `dropped: <field>` exactly per the table.
  **Mock fixture sourcing convention** (locks: prevents fixture drift between contributors):
    - `tests/e2e/fixtures/sanitized-sdk-recordings/`: sanitized HTTP transcripts captured from real SDK calls against scratch accounts, with all api keys / tokens / org IDs replaced with deterministic dummies (`sk-test-*`, `Bearer test-token-*`).
    - `tests/e2e/fixtures/handcrafted/`: hand-written minimal protocol fixtures for edge cases.
    - `tests/e2e/fixtures/golden-upstream/`: expected upstream-receive request bodies (also sanitized).
    Plain-text repo policy (F1 mechanical grep): no string matching `/sk-[A-Za-z0-9]{40,}/` or `/ghu_[A-Za-z0-9]{30,}/` may appear in any committed fixture.
  Must NOT do: NO real LLM calls in CI; NO `bun test --concurrency 4` for e2e (port conflicts); NO library-level mocking (would invalidate the whole point of using the official SDKs); NO real-world API keys in fixtures.
  Parallelization: Wave 8 | Blocked by: 31 | Blocks: 33
  References: this plan's `## IR Fitness Contract` (this todo is its enforcement gate); cross-protocol matrix from todo 17 (this todo extends it across the binary boundary).
  Acceptance criteria: 12 cross + 4 passthrough + N IR Fitness fixtures green (N ≥ 8 — one per applicable contract row); CI runs the 16 cross/passthrough + IR Fitness; Copilot smoke skipped in CI; fixture sanitization lint passes.
  QA scenarios: happy: full e2e captures junit XML + per-suite stdout to `.omo/evidence/task-32-aio-proxy.junit.xml` and `.omo/evidence/task-32-aio-proxy.txt`; failure: simulate provider 500 → ingress error envelope matches each official SDK's error class; capture per-SDK error class names to `.omo/evidence/task-32-aio-proxy-fail.txt`.
  Commit: Y | `test: full e2e via openai/@anthropic-ai/@google/genai SDKs + IR Fitness regression`

- [ ] 33. README, sample config, integration snippets, `aio-proxy config check` CLI, fill `<org>` placeholder
  What to do: `README.md` with: 30-second pitch, animated GIF of `init wizard → serve` flow, install commands (single-line `curl -fsSL https://raw.githubusercontent.com/<org>/aio-proxy/main/scripts/install.sh | sh` + `npm i -g aio-proxy-ai` + GH Releases tarball), a 10-line example `config.jsonc` covering all 3 provider kinds, integration snippets for Cursor / Codex CLI / Cline / Claude Desktop / aider (each: which baseURL field to set, no source change required), dashboard screenshot, project status badge, "What works / what doesn't" table mirroring Must have / Must NOT have. Also add `aio-proxy config check` CLI subcommand: parses `config.jsonc` via zod, exits 0 + prints "ok" if valid, exits 1 + prints zod issues path-by-path if invalid. Add `docs/` Markdown-only directory (no Astro/Docusaurus in MVP). Fill the GitHub `<org>` placeholder (decide and commit) — this is the single source of truth used by todo 30/31's URLs.
  Must NOT do: NO fictional benchmarks; NO ad copy ("the fastest", "the best"); NO trademark claims; NO embedded Apple/Google/Anthropic logos beyond brand-guideline-allowed text mentions; NO untested config examples.
  Parallelization: Wave 8 | Blocked by: 32 | Blocks: 34
  References: opencode README structure; common CLI README patterns (Bun, Hono READMEs).
  Acceptance criteria: README renders cleanly on GitHub (verify via `gh markdown-preview` or screenshot); sample config validates with `aio-proxy config check sample-config.jsonc` exit 0; `<org>` placeholder occurs zero times in any committed source under `packages/` or `scripts/` (replaced everywhere).
  QA scenarios: happy: render check + config-check output captured to `.omo/evidence/task-33-aio-proxy.txt`; failure: introduce typo in sample config → `aio-proxy config check` exits 1 with the zod issue path captured to `.omo/evidence/task-33-aio-proxy-fail.txt`; lint `grep -r "<org>"` returns zero.
  Commit: Y | `docs: README + sample config + integration snippets + config check command`

- [ ] 34. Cut `0.1.0` release: tag, publish to npm, announce
  What to do: Bump versions via `bun packages/cli/script/version.ts 0.1.0`. Push tag `v0.1.0`. Verify release pipeline succeeds end-to-end (5 binaries + npm publish + install.sh smoke). Announce via GitHub Release notes (no Slack/Discord/X in MVP). Release notes include: "What works" matrix (16 cross/passthrough + Copilot if runner has it + IR Fitness rows), "What doesn't" mirror of `Must NOT have`, install command one-liners, known limitations (`bun add` security caveat, macOS gatekeeper steps).
  Must NOT do: NO release if any e2e is red (todo 32 must be green); NO release if `aio-proxy --version` doesn't print on the macOS-arm64 host build; NO removing items from `Must NOT have` silently; NO release without F1-F4 final wave verdict APPROVE.
  Parallelization: Wave 8 | Blocked by: 33, F1-F4 | Blocks: none
  References: prior release.yml; Final verification wave below.
  Acceptance criteria: cold-install rehearsal in a clean Linux container: `npm i -g aio-proxy-ai` → `aio-proxy serve` → wizard → add OpenAI provider with throwaway test key → make a request through the `openai` SDK pointed at `:22078` → success. Same flow via `curl ... | sh`.
  QA scenarios: happy: run `docker run --rm -e OPENAI_API_KEY -v "$PWD:/work" -w /work node:22-bookworm bash -lc 'set -euo pipefail; npm i -g aio-proxy-ai; aio-proxy --version; export AIO_PROXY_HOME=$(mktemp -d); aio-proxy serve --dashboard > /tmp/aio.log 2>&1 & pid=$!; sleep 2; node tests/release/openai-smoke.mjs http://127.0.0.1:22078; curl -fsS http://127.0.0.1:22079/ | grep -q \"<div id=\\\"root\\\">\"; kill $pid; cat /tmp/aio.log' > .omo/evidence/task-34-aio-proxy.txt 2>&1`, then run the installer rehearsal after todo 31 has replaced the `<org>` placeholder: `INSTALL_URL=$(grep -Eo 'https://raw.githubusercontent.com/[^ ]+/aio-proxy/main/scripts/install.sh' README.md | head -1); test -n "$INSTALL_URL"; docker run --rm node:22-bookworm bash -lc \"curl -fsSL '$INSTALL_URL' | sh; ~/.local/bin/aio-proxy --version\" > .omo/evidence/task-34-aio-proxy-install-sh.txt 2>&1`. Failure: document rollback in `RELEASE.md`, then run `grep -E 'npm dist-tag|GitHub Release.*draft|rollback' RELEASE.md > .omo/evidence/task-34-aio-proxy-rollback.txt`; expected result is at least one npm dist-tag rewind command and one GitHub Release draft/withdraw step.
  Commit: Y | `release: 0.1.0`

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
> Canonical review target is this revised plan and the final implementation diff. Ignore any older draft phrasing if it appears in inherited checklist text.
- [ ] F1. **Plan compliance audit (Oracle, markdown audit + mechanical sub-checks)**: this is a HUMAN/Oracle audit producing `.omo/evidence/F1-plan-compliance.md`, NOT a runnable script. Mechanical sub-checks should include command output snippets from inline shell/Bun commands, not custom `scripts/check-*.ts` files. Read this plan + draft + the diff of all todo commits and assert every "Must have" (1-19) is delivered, every "Must NOT have" line is absent in the code, all decisions D1-D116 are reflected in code or explicitly waived in `RELEASE.md`. Specifically verify (with command snippet for each): every implementation todo has exactly one corresponding conventional commit with the listed `Commit: Y` message and no commit mixes multiple todos (D116); every IR Fitness Contract row has at least one e2e fixture exercising it; no root `scripts/check-*.ts` files exist; `turbo.json` exists with explicit `inputs`/`outputs`, `dev.cache=false`, e2e cache disabled, and no remote-cache secret requirement; root scripts route package-level build/check/test/dev through `turbo run`, while `preflight` is only `i18n:compile` + Turbo package check/unit test; `bun build --compile` produced binaries do NOT bundle `node-gyp` source; `aio-proxy serve` does NOT trigger any `npmAdd` (D51); ai-sdk imports occur ONLY in `packages/core/src/ai-sdk-bridge/*` (D48); auth-table queries occur ONLY in `packages/auth-flows/src/store.ts` (D46); dashboard/control code has no `/admin` routes or client calls, and dashboard CRUD uses `hc<AppType>()` over `/dashboard/*` routes except `/dashboard/events` SSE (D115); `new Database(` / `drizzle(` calls occur ONLY in `packages/core/src/db/open-db.ts` (D80); subscription `Auth.set` direct calls are absent inside `packages/core/src/provider/subscription/*` — only `Auth.cas` (D78/D91/D101); `account_fingerprint` column exists in the migration SQL (D101); no forbidden deps (D74/D77); no PascalCase file names except in the explicit allowlist (D76/D90); shadcn baseline files committed + `shadcn-provenance.md` exists (D86/D94); `route-tree.gen.ts` is gitignored (D81); re-running `drizzle-kit generate` in a clean temp copy leaves migration SQL + `migrations.manifest.ts` unchanged (D79); CLI help text routes through `m.*()` (D77/D89); commander binary smoke succeeded (D82); size cap held — gzipped JS+CSS ≤ 2.5 MB (D87/D109); `m` is the aggregated paraglide object via `export { m }` (D88); Bun transaction wrapper called as `casTx.immediate()` not `transaction(fn)("immediate")` (D104); paraglide per-call locale uses second-arg API `m.foo(args, { locale })` (D105); no `setLocale(` calls exist in server or `format-error.ts` paths (D102); `Auth.cas` is sync (no `await` calls in subscription provider code) (D110); migration sha256 verified at runtime with explicit error message (D100/D111); `bun run check` runs the i18n compile/build prerequisites through Turbo before typecheck (D112); tree-shake spike test exists and passes (D106); `openDb` registry prevents same-process self-deadlock (D107); paraglide compile uses `--emitTsDeclarations` (D108); catalog membership is limited to dependencies consumed by multiple packages or root+package, single-package-only deps are declared locally, and workspace-internal deps use `"workspace:*"` (D114). Output: `.omo/evidence/F1-plan-compliance.md` with mechanical sub-check command outputs inline.
- [ ] F2. **Code quality review (Oracle)**: read every package, flag dead code, oversized files (>250 LOC pure logic), missing types (`any` / `as unknown` / `as any`), missing JSDoc on exported APIs, security anti-patterns (token logging, `eval`, shell injection in `core/npm.ts`, raw `auth.payload` reads outside auth-flows). Specifically check: ai-sdk imports occur ONLY inside `packages/core/src/ai-sdk-bridge/*` (grep gate); no `SELECT * FROM auth` outside `packages/auth-flows/src` (grep gate); secret-pattern lint over committed fixtures returns clean. Output: `.omo/evidence/F2-code-quality.md`.
- [ ] F3. **Real manual QA (unspecified-high)**: cold-install via npm + via curl|sh on macos-arm + linux-x64 (in container). Open dashboard. Add a real OpenAI provider with a test API key. Make 5 requests through 3 client SDKs. Verify trace + usage. Stress: 50 concurrent Copilot requests with expired token → assert single refresh. Hot-reload: add a provider mid-flight → assert in-flight survives + new uses new. Output: `.omo/evidence/F3-manual-qa.md` with screenshots/logs.
- [ ] F4. **Scope fidelity (Momus)**: assert no scope creep, no Phase-2 features snuck in, no telemetry, no chat playground, no token-based local auth, no fallback chains, no Vertex/Bedrock/Azure preset, no models.dev driving routing decisions, no auto-`npmAdd` on `serve`. Verify all 18 entries in `Must NOT have` are absent. Output: `.omo/evidence/F4-scope-fidelity.md`.

## Commit strategy
- Conventional commits: `feat(<scope>): ...`, `fix(<scope>): ...`, `chore(...)`, `docs(...)`, `test(...)`, `refactor(...)`.
- Scopes: `repo`, `types`, `core`, `core/router`, `core/ingress`, `core/transform`, `core/provider`, `core/egress`, `core/npm`, `auth-flows`, `auth-flows/copilot`, `server`, `dashboard`, `cli`, `cli/build`, `cli/publish`, `release`, `ci`, `docs`.
- Each implementation todo = exactly ONE commit (Implementation + Test + Evidence merged). Commit immediately after that todo's QA passes and before starting any later todo.
- Do NOT batch multiple todos into one commit, split one todo across multiple commits, or leave completed todo work uncommitted while continuing.
- Tag releases as `v<semver>`.

## Success criteria
1. A new user can: `npm i -g aio-proxy-ai` (or `curl ... | sh`), open dashboard, configure OpenAI + Anthropic + Copilot, and route Cursor / Codex CLI / Claude Desktop through aio-proxy with **zero source code changes** to those clients (only baseURL).
2. All 16 cross-protocol+passthrough combos return semantically valid responses through each protocol's official SDK; ≥ 8 IR Fitness Contract rows are exercised by passing fixtures.
3. Binary size 90-150 MB; cold startup <500ms; same-protocol native-vendor passthrough adds <5ms latency vs direct upstream.
4. `usage` table accumulates correctly across restarts; `traces` auto-prune at 7 days; `auth` table is the ONLY home for tokens (no `auth.json`).
5. Re-running `aio-proxy serve` after editing config.jsonc requires no restart; in-flight requests survive the swap; alias-collision rejects reload but keeps OLD config serving.
6. CI is green on every PR; release tag produces 5 binaries + npm publish in <8 minutes; install.sh works from `https://raw.githubusercontent.com/<org>/aio-proxy/main/scripts/install.sh`.
7. No secrets in trace bodies (default `bodyMode: "redacted"` covers Authorization headers, API key body fields, OAuth bearer headers, URL query tokens, presigned URLs); no `auth.payload` returned via any dashboard Hono RPC endpoint.
8. `aio-proxy --version` works on every published target via native run (mac native + linux container).
9. `aio-proxy provider install <pkg>` builds the binary, self-spawns via `process.execPath + BUN_BE_BUN=1`, installs the package, and the next request to that provider works — verified end-to-end with `@ai-sdk/cohere` (NOT in BUNDLED).
10. 50 concurrent Copilot requests with expired token trigger exactly ONE refresh HTTP call (single-flight verified).
11. SSE backpressure: a slow `/dashboard/events` consumer triggers `events.dropped` then disconnect; aio-proxy memory does not grow unboundedly.
12. ai-sdk imports occur ONLY in `packages/core/src/ai-sdk-bridge/*` (grep gate); `auth` table reads occur ONLY in `packages/auth-flows/src/store.ts` (grep gate).
