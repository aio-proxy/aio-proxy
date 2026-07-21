# Provider Network Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add API provider headers, inherited/per-provider HTTP(S) proxy configuration, and one-pass `{{env.NAME}}` expansion while preserving authored configuration and existing provider fallback behavior.

**Architecture:** Keep schemas in `packages/types`, perform template expansion once in a small `packages/core` runtime parser, and materialize one proxy-aware Bun `fetch` per enabled API or AI SDK provider. Raw API and AI SDK paths receive that fetch directly; Dashboard writes continue to mutate raw records and restore authored template leaves after validating an expanded copy.

**Tech Stack:** Bun 1.3.14 native `fetch` proxy option, TypeScript 6.0, Zod 4.4, `@handlebars/parser` 2.2.2, AI SDK 7.0.8, Bun test.

## Global Constraints

- Keep this implementation URL-only: no SOCKS, bypass list, dispatcher, agent, connection pool, transport registry, or same-provider direct fallback.
- Top-level `proxy` is optional; provider `proxy` inherits when omitted, overrides with a string, and disables only aio-proxy's configured proxy with `false`.
- Accept only `http:` and `https:` proxy URLs after template expansion.
- OAuth plugin transport is out of scope.
- API provider `headers` apply to raw passthrough, probes, and all four API-to-AI-SDK bridges; configured headers are applied last.
- Expand only string values, never object keys; use one pass, substitute a missing environment variable with `""`, and never add helpers, defaults, recursion, request body/header namespaces, blocks, or partials.
- Accept only `ContentStatement` and simple `MustacheStatement` nodes whose path is exactly `env.<NAME>` and whose name matches `[A-Za-z_][A-Za-z0-9_]*`.
- Preserve existing `$NAME` API-key resolution.
- Keep authored templates in the raw config file; runtime snapshots contain expanded copies.
- Dashboard output masks every header value and every top-level/provider proxy value as `****`; submitting the placeholder restores the raw authored value.
- Built-in AI SDK packages must use the injected fetch. Dynamic packages receive it on a best-effort basis.
- Preserve model-first routing, capability dispatch, candidate order, streaming semantics, and the existing provider fallback loop.
- Do not add a Dashboard editor for these fields.
- Keep handwritten code and tests below 300 lines. Move legacy `_test/provider/*` tests next to any provider module materially changed, splitting large test files by behavior.
- Preserve the existing user-owned `bun.lock` modification and untracked `.reference`; stage only the new `@handlebars/parser` lockfile hunk.
- Run shell commands through `rtk`.
- Every commit must append `Co-authored-by: Codex <noreply@openai.com>`.

---

## Target File Map

### New core config files

- `packages/core/src/config/index.ts` — exports runtime config materialization.
- `packages/core/src/config/resolve-config-templates.ts` — Handlebars AST allowlist and immutable deep expansion.
- `packages/core/src/config/resolve-config-templates.test.ts` — evaluator contract.
- `packages/core/src/config/parse-runtime-config.ts` — the only production wrapper around `ConfigSchema`.
- `packages/core/src/config/parse-runtime-config.test.ts` — expansion-before-validation and immutability tests.

### New core transport file

- `packages/core/src/provider/proxy-fetch.ts` — Bun-native proxy-aware fetch factory.
- `packages/core/src/provider/proxy-fetch.test.ts` — exact forwarding and no-direct-fallback tests.

### Provider module moves required by repository test layout

- `packages/core/src/provider/api/{index.ts,api.ts,api.test.ts,api-stream.test.ts}` replaces `packages/core/src/provider/api.ts` and `packages/core/_test/provider/api.test.ts`.
- `packages/core/src/provider/api-bridge/{index.ts,api-bridge.ts,api-bridge.test.ts}` replaces `packages/core/src/provider/api-bridge.ts` and its legacy test.
- `packages/core/src/provider/ai-sdk/{index.ts,ai-sdk.ts,ai-sdk.test.ts,ai-sdk-stream.test.ts}` replaces `packages/core/src/provider/ai-sdk.ts` and its legacy test.
- `packages/core/src/provider/ai-sdk-loader/{index.ts,ai-sdk-loader.ts,ai-sdk-loader.test.ts}` replaces `packages/core/src/provider/ai-sdk-loader.ts` and its legacy test.
- `packages/server/src/provider-runtime/{index.ts,materialize.ts,probe.ts,materialize.test.ts}` replaces `packages/server/src/provider-runtime.ts` and `packages/server/_test/provider-runtime-capabilities.test.ts`.

### Dashboard secret module move

- `packages/server/src/dashboard-routes/provider-secrets/{index.ts,provider-secrets.ts,provider-secrets.test.ts}` replaces `packages/server/src/dashboard-routes/provider-secrets.ts`.

### Other modified files

- `packages/types/src/provider.ts`, `packages/types/src/config/config.ts`, and their colocated tests — public authored/runtime schemas.
- `packages/core/package.json`, `bun.lock`, `packages/core/src/index.ts` — parser dependency and exports.
- `packages/core/src/plugins/account-login/{validation.ts,recovery.ts}` — runtime parser use.
- `packages/cli/src/boot-proxy-server/boot-proxy-server.ts` — runtime parser use.
- `packages/server/src/server/server.ts`, `packages/server/src/server-state/{index.ts,reload.ts}` — runtime parser use.
- `packages/server/src/dashboard-routes/{config.ts,provider-mutation.ts}` — dual authored/materialized mutation parsing and hidden field preservation.
- `packages/server/src/dashboard-routes/config-network.test.ts` — route-level redaction and persistence regression.
- `npm/aio-proxy/README.md` — public configuration example and dynamic-package guarantee.

---

### Task 1: Public Authored and Runtime Schemas

**Files:**
- Modify: `packages/types/src/provider.ts`
- Modify: `packages/types/src/config/config.ts`
- Modify: `packages/types/src/config/config.test.ts`
- Modify: `packages/types/src/config/config-acceptance.test.ts`

**Interfaces:**
- Produces: `HttpProxyUrlSchema: ZodType<string>`.
- Produces: `ConfigTemplateStringSchema: ZodType<string>` for authoring-only constrained string fields.
- Produces: runtime `Config.proxy?: string`, `ApiProvider.headers?: Readonly<Record<string, string>>`, and API/AI SDK provider `proxy?: string | false`.
- Produces: `ProviderMutationAuthoringBodySchema`, `ProviderMutationAuthoringBody`, and keeps `ProviderMutationBodySchema` as the materialized runtime contract.

- [ ] **Step 1: Add failing schema tests**

Add focused cases that assert:

```ts
const runtime = ConfigSchema.parse({
  proxy: "https://proxy.example:8443",
  providers: {
    api: {
      kind: "api",
      protocol: "openai-response",
      baseURL: "https://api.example/v1",
      proxy: false,
      headers: { Authorization: "Bearer upstream", "X-Tenant": "team-a" },
    },
    sdk: {
      kind: "ai-sdk",
      packageName: "@ai-sdk/anthropic",
      proxy: "http://provider-proxy.example:8080",
    },
  },
});

expect(runtime.proxy).toBe("https://proxy.example:8443");
expect(runtime.providers[0]).toMatchObject({ proxy: false, headers: { "X-Tenant": "team-a" } });
expect(runtime.providers[1]).toMatchObject({ proxy: "http://provider-proxy.example:8080" });
expect(ConfigSchema.safeParse({ proxy: "socks5://localhost:1080", providers: {} }).success).toBe(false);
expect(
  ConfigSchema.safeParse({
    providers: {
      api: {
        kind: "api",
        protocol: "openai-response",
        baseURL: "https://api.example/v1",
        headers: { "Bad\nName": "value" },
      },
    },
  }).success,
).toBe(false);
expect(
  ConfigAuthoringSchema.safeParse({
    proxy: "{{env.PROXY_URL}}",
    providers: {
      api: {
        kind: "api",
        protocol: "openai-response",
        baseURL: "{{env.API_BASE_URL}}",
        headers: { Authorization: "Bearer {{env.API_TOKEN}}" },
      },
    },
  }).success,
).toBe(true);
```

Also assert API and AI SDK mutation authoring accepts proxy templates, API mutation accepts `headers`, and the runtime mutation schema rejects unresolved proxy/base URL templates.

- [ ] **Step 2: Run the type tests and verify red**

Run:

```bash
rtk bun test packages/types/src/config/config.test.ts packages/types/src/config/config-acceptance.test.ts
```

Expected: FAIL because the new fields and authoring/runtime distinction do not exist.

- [ ] **Step 3: Implement the narrow schemas**

Add these primitives and use them in the runtime provider/config schemas:

```ts
export const ConfigTemplateStringSchema = z.string().regex(/\{\{[\s\S]*\}\}/u, "Expected a config template");

export const HttpProxyUrlSchema = z.url().refine(
  (value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  },
  "Proxy URL must use http: or https:",
);

const ProviderProxySchema = z.union([HttpProxyUrlSchema, z.literal(false)]).optional();
const AuthoringProviderProxySchema = z.union([HttpProxyUrlSchema, ConfigTemplateStringSchema, z.literal(false)]).optional();

const ApiHeadersSchema = z.record(z.string(), z.string()).superRefine((headers, context) => {
  try {
    new Headers(headers);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid headers" });
  }
});
```

Define runtime and authoring API/AI SDK variants from shared shapes instead of duplicating them. Runtime variants use `z.url()`/`ProviderProxySchema`; authoring variants replace constrained URL fields with `z.union([z.url(), ConfigTemplateStringSchema])` and use `AuthoringProviderProxySchema`. Keep provider `id` and object keys literal/non-templated because they identify the record being mutated; every persisted string leaf is still expanded by Task 2.

Add `proxy` to both `ConfigEnvelopeSchema` and `ConfigAuthoringSchema`, carry it through the `ConfigSchema` transform, and add `headers`/`proxy` to mutation variants. Export a separate `ProviderMutationAuthoringBodySchema` plus its Zod input/output types; preserve the existing alias normalization transform on both mutation schemas.

- [ ] **Step 4: Run the schema tests and generated-schema build**

Run:

```bash
rtk bun test packages/types/src/config/config.test.ts packages/types/src/config/config-acceptance.test.ts
rtk bun run --filter @aio-proxy/types build
```

Expected: PASS; generated `dist/config.schema.json` contains top-level `proxy`, API `headers`, and provider `proxy` without changing tracked source artifacts.

- [ ] **Step 5: Commit the schema contract**

```bash
rtk git add packages/types/src/provider.ts packages/types/src/config/config.ts packages/types/src/config/config.test.ts packages/types/src/config/config-acceptance.test.ts
rtk git commit -m "feat(types): add provider network config" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: One-Pass Runtime Template Materialization

**Files:**
- Modify: `packages/core/package.json`
- Modify selectively: `bun.lock`
- Create: `packages/core/src/config/index.ts`
- Create: `packages/core/src/config/resolve-config-templates.ts`
- Create: `packages/core/src/config/resolve-config-templates.test.ts`
- Create: `packages/core/src/config/parse-runtime-config.ts`
- Create: `packages/core/src/config/parse-runtime-config.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `resolveConfigTemplates(value: unknown, env?: Readonly<Record<string, string | undefined>>): unknown`.
- Produces: `parseRuntimeConfig(value: unknown, env?: Readonly<Record<string, string | undefined>>): Config`.
- Consumes: `ConfigSchema` from Task 1 and `parse`, `AST` from `@handlebars/parser`.

- [ ] **Step 1: Install only the parse dependency**

Run:

```bash
rtk bun add @handlebars/parser@2.2.2 --cwd packages/core
rtk git diff -- packages/core/package.json bun.lock
```

Expected: `packages/core/package.json` lists exactly `"@handlebars/parser": "2.2.2"`; `bun.lock` contains its lock entry. Do not stage unrelated pre-existing lockfile changes.

- [ ] **Step 2: Write failing evaluator and wrapper tests**

Cover literal strings, one/multiple/interpolated variables, missing variables, non-recursion, arrays, unchanged keys/non-strings, immutability, and parser rejection. Use this rejection table:

```ts
const rejected = [
  "{{uppercase env.TOKEN}}",
  "{{#if env.TOKEN}}yes{{/if}}",
  "{{> partial}}",
  "{{unknown.TOKEN}}",
  "{{env.1TOKEN}}",
  "{{{env.TOKEN}}}",
  "{{! comment}}",
];
```

The wrapper test must prove expansion occurs before URL/header validation and the raw record remains byte-for-byte equal through `structuredClone` comparison.

- [ ] **Step 3: Run the tests and verify red**

```bash
rtk bun test packages/core/src/config/resolve-config-templates.test.ts packages/core/src/config/parse-runtime-config.test.ts
```

Expected: FAIL because `packages/core/src/config` does not exist.

- [ ] **Step 4: Implement the immutable AST allowlist**

Create `resolve-config-templates.ts` with this complete evaluator shape:

```ts
import { type AST, parse } from "@handlebars/parser";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function resolveConfigTemplates(
  value: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): unknown {
  if (typeof value === "string") return resolveString(value, env);
  if (Array.isArray(value)) return value.map((item) => resolveConfigTemplates(item, env));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, resolveConfigTemplates(child, env)]),
  );
}

function resolveString(value: string, env: Readonly<Record<string, string | undefined>>): string {
  const program = parse(value);
  return program.body.map((statement) => evaluateStatement(statement, env)).join("");
}

function evaluateStatement(
  statement: AST.Statement,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (statement.type === "ContentStatement") return (statement as AST.ContentStatement).value;
  if (statement.type !== "MustacheStatement") throw invalidTemplate(statement);
  const mustache = statement as AST.MustacheStatement;
  if (!mustache.escaped || mustache.params.length > 0 || mustache.hash.pairs.length > 0) throw invalidTemplate(statement);
  if (mustache.path.type !== "PathExpression") throw invalidTemplate(statement);
  const path = mustache.path as AST.PathExpression;
  if (path.data || path.depth !== 0 || path.parts.length !== 2 || path.parts[0] !== "env") throw invalidTemplate(statement);
  const name = path.parts[1];
  if (typeof name !== "string" || !ENV_NAME.test(name)) throw invalidTemplate(statement);
  return env[name] ?? "";
}

function invalidTemplate(node: AST.Node): TypeError {
  return new TypeError(`Unsupported config template at ${node.loc.start.line}:${node.loc.start.column}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
```

Create `parse-runtime-config.ts`:

```ts
import { type Config, ConfigSchema } from "@aio-proxy/types";
import { resolveConfigTemplates } from "./resolve-config-templates";

export function parseRuntimeConfig(
  value: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Config {
  return ConfigSchema.parse(resolveConfigTemplates(value, env));
}
```

Export both functions from `packages/core/src/config/index.ts` and the core package root.

- [ ] **Step 5: Run focused tests and typecheck through the package build**

```bash
rtk bun test packages/core/src/config/resolve-config-templates.test.ts packages/core/src/config/parse-runtime-config.test.ts
rtk bun run --filter @aio-proxy/core build
```

Expected: PASS.

- [ ] **Step 6: Stage the dependency safely and commit**

```bash
rtk git add packages/core/package.json packages/core/src/config packages/core/src/index.ts
rtk git add -p bun.lock
rtk git diff --cached --check
rtk git diff --cached -- bun.lock
```

Expected: the cached lock diff contains only `@handlebars/parser@2.2.2` changes. Then run:

```bash
rtk git commit -m "feat(core): materialize config environment templates" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Route Every Production Config Load Through the Wrapper

**Files:**
- Modify: `packages/cli/src/boot-proxy-server/boot-proxy-server.ts`
- Modify: `packages/server/src/server/server.ts`
- Modify: `packages/server/src/server-state/index.ts`
- Modify: `packages/server/src/server-state/reload.ts`
- Modify: `packages/core/src/plugins/account-login/validation.ts`
- Modify: `packages/core/src/plugins/account-login/recovery.ts`
- Test: `packages/core/src/config/parse-runtime-config.test.ts`
- Test: `packages/server/_test/config-store.test.ts`

**Interfaces:**
- Consumes: `parseRuntimeConfig(value, env?)` from Task 2.
- Preserves: raw `AtomicConfigFile` records for transaction output and serialization.

- [ ] **Step 1: Add a failing raw-file persistence regression**

Extend `packages/server/_test/config-store.test.ts` with a transaction using:

```ts
const authored = {
  proxy: "{{env.GLOBAL_PROXY}}",
  providers: {
    api: {
      kind: "api",
      protocol: "openai-response",
      baseURL: "https://api.example/v1",
      headers: { Authorization: "Bearer {{env.UPSTREAM_TOKEN}}" },
    },
  },
};
```

Set the two environment variables, mutate an unrelated provider field, and assert the persisted record still contains both exact template strings while `state.currentConfig()` contains expanded values.

- [ ] **Step 2: Run the regression and verify red**

```bash
rtk bun test packages/server/_test/config-store.test.ts
```

Expected: FAIL because config-store verification still calls `ConfigSchema.parse` directly.

- [ ] **Step 3: Replace production materialization calls**

Use `parseRuntimeConfig` in exactly these places:

```ts
// packages/cli/src/boot-proxy-server/boot-proxy-server.ts
const config = parseRuntimeConfig(options.config);

// packages/server/src/server/server.ts
const config = parseRuntimeConfig(prepared.config);

// packages/server/src/server-state/index.ts
verify: (candidate) => commitConfig(parseRuntimeConfig(candidate), "config-store"),

// packages/server/src/server-state/reload.ts
if (!commitAfterWrite) retired = await commitConfig(parseRuntimeConfig(next), "reload");
if (commitAfterWrite) retired = await commitConfig(parseRuntimeConfig(candidate), "reload");
```

In core account-login validation and recovery, import from the local core config module and replace every `ConfigSchema.parse/safeParse` validation of raw records with `parseRuntimeConfig`/a `try` around it. Do not change calls in unit-test fixtures that intentionally test `ConfigSchema` itself.

- [ ] **Step 4: Run affected package tests**

```bash
rtk bun test packages/core/src/plugins/account-login packages/server/_test/config-store.test.ts packages/server/src/server-state
rtk bun run --filter @aio-proxy/cli build
```

Expected: PASS; invalid templates reject the candidate before atomic write, and authored records remain unchanged.

- [ ] **Step 5: Commit the single materialization boundary**

```bash
rtk git add packages/cli/src/boot-proxy-server/boot-proxy-server.ts packages/server/src/server/server.ts packages/server/src/server-state/index.ts packages/server/src/server-state/reload.ts packages/core/src/plugins/account-login/validation.ts packages/core/src/plugins/account-login/recovery.ts packages/core/src/config/parse-runtime-config.test.ts packages/server/_test/config-store.test.ts
rtk git commit -m "refactor(config): centralize runtime materialization" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Effective Proxy Fetch and Provider Runtime Materialization

**Files:**
- Create: `packages/core/src/provider/proxy-fetch.ts`
- Create: `packages/core/src/provider/proxy-fetch.test.ts`
- Modify: `packages/core/src/index.ts`
- Replace: `packages/server/src/provider-runtime.ts` with `packages/server/src/provider-runtime/{index.ts,materialize.ts,probe.ts,materialize.test.ts}`
- Move/split: `packages/server/_test/provider-runtime-capabilities.test.ts`

**Interfaces:**
- Produces: `ProviderFetch = typeof globalThis.fetch`.
- Produces: `createProxyFetch(proxy?: string, fetchImpl?: ProviderFetch): ProviderFetch`.
- Produces privately in server: `effectiveProxy(globalProxy: string | undefined, providerProxy: string | false | undefined): string | undefined`.
- Extends: `MaterializeProvidersOptions` with injectable `createApiProvider`, `createAiSdkProvider`, and `createProxyFetch` factory seams for deterministic tests.

- [ ] **Step 1: Move the runtime module by responsibility**

Use `git mv` for history, then split without behavior changes:

```bash
mkdir -p packages/server/src/provider-runtime
rtk git mv packages/server/src/provider-runtime.ts packages/server/src/provider-runtime/materialize.ts
rtk git mv packages/server/_test/provider-runtime-capabilities.test.ts packages/server/src/provider-runtime/materialize.test.ts
```

Move `probeApi`, `providerProbeRequest`, `providerProbeModel`, `probeAiSdk`, and probe constants to private `probe.ts`. Create export-only `index.ts` for the public exports previously provided by `provider-runtime.ts`. Run the moved test before adding proxy behavior.

- [ ] **Step 2: Write failing proxy helper and inheritance tests**

Test `createProxyFetch` with an injected spy and assert the exact call:

```ts
expect(calls).toEqual([
  ["https://upstream.example/v1", { method: "POST", proxy: "http://proxy.example:8080" }],
]);
```

In `materialize.test.ts`, inject/capture raw and AI SDK factory fetches and cover global inheritance, provider override, `false`, and no configured proxy. Assert a rejecting proxy fetch produces one rejection and is never retried without `proxy`.

- [ ] **Step 3: Run focused tests and verify red**

```bash
rtk bun test packages/core/src/provider/proxy-fetch.test.ts packages/server/src/provider-runtime/materialize.test.ts
```

Expected: FAIL because fetch injection and proxy resolution do not exist.

- [ ] **Step 4: Implement the minimal fetch wrapper**

```ts
export type ProviderFetch = typeof globalThis.fetch;

export function createProxyFetch(
  proxy: string | undefined,
  fetchImpl: ProviderFetch = globalThis.fetch,
): ProviderFetch {
  if (proxy === undefined) return fetchImpl;
  return ((input: Parameters<ProviderFetch>[0], init?: Parameters<ProviderFetch>[1]) =>
    fetchImpl(input, { ...init, proxy })) as ProviderFetch;
}
```

In server materialization, compute once per enabled provider:

```ts
function effectiveProxy(
  globalProxy: string | undefined,
  providerProxy: string | false | undefined,
): string | undefined {
  if (providerProxy === false) return undefined;
  return providerProxy ?? globalProxy;
}

const providerFetch = createProxyFetch(effectiveProxy(config.proxy, provider.proxy));
```

Resolve factory seams once at the top of `materializeProviders`:

```ts
const createApi = options.createApiProvider ?? createApiProvider;
const createAiSdk = options.createAiSdkProvider ?? createAiSdkProvider;
const createFetch = options.createProxyFetch ?? createProxyFetch;
```

Pass the same `providerFetch` to `createApi(provider, { fetch: providerFetch })` and `bridgeApiProvider(provider, { fetch: providerFetch })`; pass it to `createAiSdk(provider, { fetch: providerFetch })` for direct AI SDK providers. Keep the candidate loop untouched so proxy errors naturally enter existing fallback.

- [ ] **Step 5: Run focused runtime tests**

```bash
rtk bun test packages/core/src/provider/proxy-fetch.test.ts packages/server/src/provider-runtime/materialize.test.ts
```

Expected: PASS; moved source/test files remain below 300 lines.

- [ ] **Step 6: Commit the runtime wiring**

```bash
rtk git add packages/core/src/provider/proxy-fetch.ts packages/core/src/provider/proxy-fetch.test.ts packages/core/src/index.ts packages/server/src/provider-runtime packages/server/src/provider-runtime.ts packages/server/_test/provider-runtime-capabilities.test.ts
rtk git commit -m "feat(server): resolve provider proxy fetch" -m "Co-authored-by: Codex <noreply@openai.com>"
```

The two removed paths in `git add` intentionally stage deletions after `git mv`.

---

### Task 5: Raw API Headers and Fetch Injection

**Files:**
- Replace: `packages/core/src/provider/api.ts` with `packages/core/src/provider/api/{index.ts,api.ts,api.test.ts,api-stream.test.ts}`
- Move/split: `packages/core/_test/provider/api.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Extends: `ApiProviderFactoryOptions` with `fetch?: ProviderFetch`.
- Consumes: materialized `ApiProvider.headers` from Task 1.
- Preserves: `resolveApiKey()` and raw response/trace behavior.

- [ ] **Step 1: Move and split the legacy tests**

```bash
mkdir -p packages/core/src/provider/api
rtk git mv packages/core/src/provider/api.ts packages/core/src/provider/api/api.ts
rtk git mv packages/core/_test/provider/api.test.ts packages/core/src/provider/api/api.test.ts
```

Move the SSE, decompression, zstd, and 429 trace cases into `api-stream.test.ts`; keep request rewrite/header cases in `api.test.ts`. Create export-only `index.ts`, then run both tests to prove the move is green.

- [ ] **Step 2: Add failing header precedence and injected-fetch tests**

Add one table-driven test for OpenAI Responses/OpenAI-compatible, Anthropic, and Gemini. For each protocol, send conflicting inbound credentials and configure:

```ts
headers: {
  Authorization: "Configured authorization",
  Host: "configured-host.example",
  "X-Api-Key": "configured-api-key",
  "X-Goog-Api-Key": "configured-google-key",
  "Accept-Encoding": "configured-encoding",
  "X-Tenant": "team-a",
},
```

Assert the injected fetch sees every configured value, proving configured headers win after stripping inbound credentials and applying defaults/API-key auth.

- [ ] **Step 3: Run the raw API tests and verify red**

```bash
rtk bun test packages/core/src/provider/api/api.test.ts packages/core/src/provider/api/api-stream.test.ts
```

Expected: FAIL because `ApiProviderFactoryOptions.fetch` and configured-header merging are absent.

- [ ] **Step 4: Implement final-write header semantics**

Select fetch once in `createApiProvider`:

```ts
const fetchUpstream = options.fetch ?? globalThis.fetch;
```

Change the helper signature and apply configured headers last:

```ts
function upstreamHeaders(
  inbound: Headers,
  protocol: ProviderProtocol,
  apiKey: string | undefined,
  configured: Readonly<Record<string, string>> | undefined,
): Headers {
  const headers = new Headers(inbound);
  headers.delete("host");
  for (const name of CLIENT_CREDENTIAL_HEADERS) headers.delete(name);
  headers.set("accept-encoding", "identity");
  headers.set("x-forwarded-by", "aio-proxy/0.0.0");
  if (apiKey !== undefined) {
    if (protocol === ProviderProtocol.Anthropic) headers.set("x-api-key", apiKey);
    else if (protocol === ProviderProtocol.Gemini) headers.set("x-goog-api-key", apiKey);
    else headers.set("authorization", `Bearer ${apiKey}`);
  }
  for (const [name, value] of Object.entries(configured ?? {})) headers.set(name, value);
  return headers;
}
```

Call `fetchUpstream` for passthrough. Because probes call the same `instance.passthrough`, they inherit both proxy and header behavior without a second code path.

- [ ] **Step 5: Run raw transport tests**

```bash
rtk bun test packages/core/src/provider/api
```

Expected: PASS, including unchanged byte/SSE/trace cases.

- [ ] **Step 6: Commit raw transport support**

```bash
rtk git add packages/core/src/provider/api packages/core/src/provider/api.ts packages/core/_test/provider/api.test.ts packages/core/src/index.ts
rtk git commit -m "feat(core): apply API provider headers" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: AI SDK Bridge and Direct Provider Fetch Propagation

**Files:**
- Replace: `packages/core/src/provider/api-bridge.ts` with `packages/core/src/provider/api-bridge/{index.ts,api-bridge.ts,api-bridge.test.ts}`
- Replace: `packages/core/src/provider/ai-sdk.ts` with `packages/core/src/provider/ai-sdk/{index.ts,ai-sdk.ts,ai-sdk.test.ts,ai-sdk-stream.test.ts}`
- Replace: `packages/core/src/provider/ai-sdk-loader.ts` with `packages/core/src/provider/ai-sdk-loader/{index.ts,ai-sdk-loader.ts,ai-sdk-loader.test.ts}`
- Move/split: the corresponding three `packages/core/_test/provider/*.test.ts` files
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Extends: `AiSdkProviderFactoryOptions` with `fetch?: ProviderFetch`.
- Extends: `AiSdkProviderLoadOptions` with `fetch?: ProviderFetch`.
- Consumes: API `headers` and the exact `ProviderFetch` created in Task 4.

- [ ] **Step 1: Move/split legacy modules and tests without behavior changes**

Use `git mv`; split the 508-line AI SDK test so stream/reasoning cases live in `ai-sdk-stream.test.ts`. Keep every `index.ts` export-only and every handwritten file below 300 lines. Run the moved test directories before adding behavior.

- [ ] **Step 2: Add failing fetch/header propagation tests**

Add assertions that:

- direct `createAiSdkProvider` calls `loadProvider(packageName, { ...options, fetch })` and the injected fetch wins over any serializable `options.fetch` value;
- each of the four API protocols passes `headers` in synthesized factory options and passes the same fetch object through;
- `@ai-sdk/openai-compatible` passes `fetch` into `createOpenAICompatible` instead of dropping it;
- the existing normal and streaming model tests remain byte/event identical.

Use identity assertions such as:

```ts
expect(receivedOptions?.fetch).toBe(providerFetch);
expect(receivedOptions?.headers).toEqual({ Authorization: "Bearer configured", "X-Tenant": "team-a" });
```

- [ ] **Step 3: Run the provider tests and verify red**

```bash
rtk bun test packages/core/src/provider/api-bridge packages/core/src/provider/ai-sdk packages/core/src/provider/ai-sdk-loader
```

Expected: FAIL on missing fetch/header propagation.

- [ ] **Step 4: Merge runtime fetch into AI SDK options**

Add `fetch?: ProviderFetch` to both option types. Change `loadOptions` to accept the factory fetch and write it last:

```ts
function loadOptions(config: AiSdkProvider, providerFetch: ProviderFetch | undefined): AiSdkProviderLoadOptions {
  const configured = config.options ?? {};
  const options = providerFetch === undefined ? configured : { ...configured, fetch: providerFetch };
  if (config.packageName !== "@ai-sdk/openai-compatible" || options["name"] !== undefined) return options;
  return { ...options, name: config.id };
}
```

Call it as `loadOptions(config, options.fetch)`. In the API bridge, add `headers: provider.headers` to shared synthesized options when present and forward `options.fetch` unchanged to `createAiSdkProvider`.

In the OpenAI-compatible bundled loader reconstruction, add:

```ts
...(options.fetch === undefined ? {} : { fetch: options.fetch }),
```

The other seven bundled factories already forward the complete options object and need no branch-specific code.

- [ ] **Step 5: Run all provider tests**

```bash
rtk bun test packages/core/src/provider
```

Expected: PASS; normal and streaming behavior is unchanged.

- [ ] **Step 6: Commit model transport propagation**

```bash
rtk git add packages/core/src/provider/api-bridge packages/core/src/provider/ai-sdk packages/core/src/provider/ai-sdk-loader packages/core/src/provider/api-bridge.ts packages/core/src/provider/ai-sdk.ts packages/core/src/provider/ai-sdk-loader.ts packages/core/_test/provider/api-bridge.test.ts packages/core/_test/provider/ai-sdk.test.ts packages/core/_test/provider/ai-sdk-loader.test.ts packages/core/src/index.ts
rtk git commit -m "feat(core): propagate provider network options" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 7: Dashboard Redaction, Template Retention, and Atomic Mutations

**Files:**
- Replace: `packages/server/src/dashboard-routes/provider-secrets.ts` with `packages/server/src/dashboard-routes/provider-secrets/{index.ts,provider-secrets.ts,provider-secrets.test.ts}`
- Modify: `packages/server/src/dashboard-routes/provider-mutation.ts`
- Modify: `packages/server/src/dashboard-routes/config.ts`
- Create: `packages/server/src/dashboard-routes/config-network.test.ts`

**Interfaces:**
- Produces: `retainAuthoredTemplateStrings(authored, submitted, env?): unknown` inside the secret-retention module.
- Consumes: `ProviderMutationAuthoringBodySchema`, `ProviderMutationBodySchema`, and `resolveConfigTemplates`.
- Preserves: normalized aliases and raw authored strings while using materialized values for route decisions.

- [ ] **Step 1: Move the secret module and write failing unit tests**

Test that `redactSecrets` maps all values below to `****`:

```ts
{
  proxy: "http://user:password@proxy.example:8080",
  providers: [
    {
      proxy: "{{env.PROVIDER_PROXY}}",
      headers: { Authorization: "Bearer expanded-secret", "X-Tenant": "expanded-tenant" },
    },
  ],
}
```

Test placeholder submission restores raw proxy/header templates, and submitted expanded values equal to a previous template expansion restore the authored template. Also assert keys absent from the submitted object are not generically copied back.

- [ ] **Step 2: Add failing route-level persistence tests**

Create a Dashboard route test that starts with raw API and AI SDK providers containing proxy/header/baseURL templates. Verify:

1. `GET /config` and `GET /providers/:id/edit-view` contain neither expanded proxy credentials nor header values.
2. An unrelated provider edit retains omitted `headers` and `proxy` explicitly.
3. Submitting `****` retains raw values.
4. Submitting the displayed expanded `baseURL` retains the authored `{{env.API_BASE_URL}}`.
5. A malformed template or expanded SOCKS URL returns `422` and does not alter the file.

- [ ] **Step 3: Run dashboard tests and verify red**

```bash
rtk bun test packages/server/src/dashboard-routes/provider-secrets packages/server/src/dashboard-routes/config-network.test.ts
```

Expected: FAIL because proxy masking, template restoration, and dual mutation parsing are absent.

- [ ] **Step 4: Extend redaction and narrow retention**

Treat `proxy` exactly like the existing `headers` secret boundary:

```ts
if (SENSITIVE_KEY_PATTERN.test(key) || key.toLowerCase() === "headers" || key.toLowerCase() === "proxy") {
  return "****";
}
```

Implement template restoration by iterating only submitted keys. For a submitted string, resolve the previous authored string once; restore it only when it contains a mustache and the submitted value equals the expansion. Recurse through arrays and records without copying absent previous keys. This prevents unknown stripped fields from reappearing.

In `replaceProvider`, explicitly preserve omitted `headers` and `proxy` because the Dashboard has no editor for them:

```ts
for (const key of ["headers", "proxy"] as const) {
  if (provider[key] === undefined && previous[key] !== undefined) next[key] = previous[key];
}
```

Then apply redacted-secret retention and authored-template restoration. Keep existing explicit `alias` and `apiKey` rules.

- [ ] **Step 5: Parse mutation control values from an expanded copy**

Change the validator result to carry both forms:

```ts
type ParsedProviderMutation = {
  readonly authored: ProviderMutationAuthoringBody;
  readonly materialized: ProviderMutationBody;
};
```

First parse `raw` with `ProviderMutationAuthoringBodySchema`, expand that parsed object, then parse with `ProviderMutationBodySchema`. Use `materialized.id/kind` for route checks and branching; persist `authored` after removing `id`. Because the authoring schema retains the existing alias transform, alias keys stay normalized while template leaves remain authored.

- [ ] **Step 6: Run Dashboard and config-store tests**

```bash
rtk bun test packages/server/src/dashboard-routes/provider-secrets packages/server/src/dashboard-routes/config-network.test.ts packages/server/_test/config-store.test.ts
```

Expected: PASS; raw files retain templates and runtime snapshots use expanded values.

- [ ] **Step 7: Commit safe Dashboard behavior**

```bash
rtk git add packages/server/src/dashboard-routes/provider-secrets packages/server/src/dashboard-routes/provider-secrets.ts packages/server/src/dashboard-routes/provider-mutation.ts packages/server/src/dashboard-routes/config.ts packages/server/src/dashboard-routes/config-network.test.ts
rtk git commit -m "fix(dashboard): preserve provider network secrets" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 8: Fallback Integration, Documentation, and Full Verification

**Files:**
- Modify: the existing server dispatch-matrix test that covers provider fallback
- Modify: `npm/aio-proxy/README.md`
- Verify: generated `packages/types/dist/config.schema.json` during build only

**Interfaces:**
- Consumes: all previous tasks.
- Verifies: a proxy transport error is one provider-attempt failure, followed by the next Provider ID, without a direct retry of the first provider.

- [ ] **Step 1: Add the final routing regression**

Add two API providers exposing the same alias. Start a local Bun upstream for each provider, reserve and close another local port, configure the higher-weight provider's `proxy` as that closed `http://127.0.0.1:<port>` address, and set the lower-weight provider's `proxy` to `false`. Assert attempt order is the two Provider IDs exactly once each, the request succeeds through the second provider, and the first provider's upstream records zero requests. That zero count proves there was no silent direct retry after the proxy connection failed.

Also assert the request diagnostic record contains no configured header value, proxy credential, or proxy URL.

- [ ] **Step 2: Run the integration regression**

Run the exact server test file selected for the dispatch matrix:

```bash
rtk bun test packages/server/_test/cross-protocol-routing.test.ts
```

Expected: PASS using Bun's real proxy connection failure and the existing pipeline fallback; no pipeline implementation change is permitted in this task.

- [ ] **Step 3: Document the public contract**

Add one compact configuration section to `npm/aio-proxy/README.md` containing the approved YAML example with top-level proxy, API `headers`, provider `false`, and `{{env.NAME}}`. State explicitly:

- only HTTP(S) proxy URLs are supported;
- provider proxy inherits/overrides/disables top-level proxy;
- headers apply last to raw and bridged calls;
- templates are one-pass environment substitutions and missing values become empty strings before validation;
- built-in AI SDK packages guarantee injected proxy fetch support, while third-party dynamic packages are best effort.

- [ ] **Step 4: Run focused affected suites**

```bash
rtk bun test packages/types/src/config packages/core/src/config packages/core/src/provider packages/server/src/provider-runtime packages/server/src/dashboard-routes/config-network.test.ts packages/server/_test/cross-protocol-routing.test.ts packages/server/_test/config-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run repository preflight**

```bash
rtk bun run preflight
```

Expected: PASS for oxlint, oxfmt check, all unit tests, plugin SDK type tests, artifact tests, and dev-task graph tests.

- [ ] **Step 6: Inspect final scope and commit**

```bash
rtk git status --short
rtk git diff --check
rtk git diff --stat HEAD
```

Expected: `.reference` remains untracked; no unrelated pre-existing `bun.lock` hunk is staged or committed; all changed handwritten files are below 300 lines.

```bash
rtk git add npm/aio-proxy/README.md packages/server/_test/cross-protocol-routing.test.ts
rtk git commit -m "test: cover provider proxy fallback" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Completion Checklist

- [ ] Top-level/API/AI SDK proxy schema, inheritance, override, and `false` behavior are covered.
- [ ] API headers are validated after expansion and win in raw and all bridge protocols.
- [ ] The AST evaluator rejects every syntax outside simple `env.*` references.
- [ ] Every production raw-config materialization entry uses `parseRuntimeConfig`.
- [ ] Raw authored templates survive reloads and Dashboard mutations.
- [ ] Dashboard masks proxy/header values and does not restore unknown stripped fields.
- [ ] Built-in and dynamic AI SDK loaders receive the proxy-aware fetch; OpenAI-compatible does not drop it.
- [ ] Proxy failure uses existing Provider ID fallback with no direct retry.
- [ ] OAuth plugin transport, request body/header templates, SOCKS, bypass, pools, and transport abstractions remain absent.
- [ ] `rtk bun run preflight` passes.
