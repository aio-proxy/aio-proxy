# Codex Client Models Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a Codex-format model catalog (`{"models":[...]}`) from `GET /v1/models` when the request carries a `client_version` query key, while leaving the standard list untouched otherwise.

**Architecture:** A shared model-resolution layer produces a neutral `ResolvedModel[]`; `listModels()` (existing) and a new `codexClientModels()` each project their own response shape from it. Codex rich fields come from a file-cached download of the upstream `models.json`; the ~17.7KB system-prompt text ships as a static markdown snapshot with a `{{model_name}}` placeholder. The upstream item shape is one shared zod schema in `@aio-proxy/types`, consumed by both the endpoint (full) and the openai-chatgpt plugin (via `.pick`).

**Tech Stack:** Bun, TypeScript, Hono, zod, es-toolkit, Turborepo. Tests via `bun test`.

## Global Constraints

- Bun + Turborepo monorepo. Before completion run `bun run preflight` (or at minimum `bun run check` plus affected package tests).
- `zod`: server/plugin code imports it via `@aio-proxy/plugin-sdk`'s `zod` export (`export { z as zod } from "zod"`). Code inside `@aio-proxy/types` imports `import { z } from "zod"` (matches existing `packages/types/src/provider.ts`).
- Prefer `es-toolkit` with narrow imports (`es-toolkit/fp`, `es-toolkit/array`, etc.).
- Colocated test layout: `foo/index.ts` (exports only) + `foo/foo.ts` (impl) + `foo/foo.test.ts`. Private siblings `foo/bar.ts` not imported outside `foo/`.
- Handwritten files <= 300 lines. The markdown snapshot is a declarative fixture (exempt).
- Text-asset import: `import md from "./x.md" with { type: "text" }` (Bun-native). Verified it survives `bun build --compile`: the `.md` is inlined into the single-file binary and readable from any cwd, so no `readFileSync`/`Bun.file` fallback is needed. The CLI binary is built via `packages/cli/scripts/build-binary.ts` (`Bun.build({ compile })`).
- Filesystem paths go through `packages/core/src/paths/paths.ts` and honor `AIO_PROXY_HOME`.
- Terminology: Provider ID, Provider weight.
- Branch prefix `codex/`; commit footer `Co-authored-by: Codex <noreply@openai.com>`.
- Upstream URL: `https://github.com/openai/codex/raw/refs/heads/main/codex-rs/models-manager/models.json`.

## File Structure

- `packages/types/src/codex-model/` — shared upstream Codex item schema.
  - `index.ts` — re-export the schema + types.
  - `codex-model.ts` — `CodexUpstreamModelSchema`, `CodexUpstreamModel`, `CodexLeanModelSchema`.
  - `codex-model.test.ts` — schema parse/pick behavior.
- `packages/core/src/paths/paths.ts` (modify) — add `codexModelsCachePath()`.
- `packages/server/src/server/model-resolution/` — shared resolution layer.
  - `index.ts` — exports.
  - `model-resolution.ts` — `resolveEnabledModels`, `ResolvedModel` (with a private `resolveDisplayName` helper).
  - `model-resolution.test.ts`.
- `packages/server/src/server/codex-client-models/` — the endpoint logic.
  - `index.ts` — exports `codexClientModels`.
  - `codex-client-models.ts` — orchestration (cache read/refresh, Case A/B, sort).
  - `codex-cache.ts` — file cache read/refresh (private sibling).
  - `codex-assembly.ts` — Case B field-by-field zod schema + defaults + md substitution (private sibling).
  - `default-instructions.md` — 5.6 snapshot with `{{model_name}}` (declarative fixture).
  - `codex-client-models.test.ts`.
- `packages/plugins/openai-chatgpt/src/catalog.ts` (modify) — consume shared schema via `.pick`.
- `packages/server/src/server/server.ts` (modify) — refactor `listModels` onto the shared layer; add the query-key branch.

---

## Task 1: Shared upstream Codex item schema in `@aio-proxy/types`

**Files:**
- Create: `packages/types/src/codex-model/index.ts`
- Create: `packages/types/src/codex-model/codex-model.ts`
- Test: `packages/types/src/codex-model/codex-model.test.ts`
- Modify: `packages/types/src/index.ts` (add `export * from "./codex-model/index";`)

**Interfaces:**
- Produces: `CodexUpstreamModelSchema` (zod, `.loose()`), type `CodexUpstreamModel`, and `CodexLeanModelSchema` built by picking `{ slug, display_name, priority, supported_in_api, visibility }` from the non-loose base object (NOT from the loose upstream schema, whose catchall would retain unknown keys).

- [ ] **Step 1: Write the failing test**

```ts
// packages/types/src/codex-model/codex-model.test.ts
import { expect, test } from "bun:test";

import { CodexLeanModelSchema, CodexUpstreamModelSchema } from "./codex-model";

test("upstream schema keeps unknown fields via loose", () => {
  const parsed = CodexUpstreamModelSchema.parse({
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6-Sol",
    priority: 1,
    supported_in_api: true,
    visibility: "list",
    base_instructions: "long text",
    some_new_upstream_field: 42,
  });
  expect(parsed.slug).toBe("gpt-5.6-sol");
  expect((parsed as Record<string, unknown>).some_new_upstream_field).toBe(42);
});

test("lean schema drops rich fields", () => {
  const lean = CodexLeanModelSchema.parse({
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6-Sol",
    priority: 1,
    supported_in_api: true,
    visibility: "list",
    base_instructions: "dropped",
  });
  expect(Object.keys(lean).sort()).toEqual(
    ["display_name", "priority", "slug", "supported_in_api", "visibility"].sort(),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/types && bun test src/codex-model/codex-model.test.ts`
Expected: FAIL — module `./codex-model` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/types/src/codex-model/codex-model.ts
import { z } from "zod";

const CodexModelBaseSchema = z.object({
  slug: z.string().min(1),
  display_name: z.string().min(1),
  priority: z.number(),
  supported_in_api: z.boolean(),
  visibility: z.string(),
});

// Upstream items carry many rich fields (base_instructions, model_messages, ...);
// keep them via loose() so Case A can pass the item through verbatim.
export const CodexUpstreamModelSchema = CodexModelBaseSchema.loose();

export type CodexUpstreamModel = z.infer<typeof CodexUpstreamModelSchema>;

// Pick from the non-loose base: picking from a loose() schema inherits its
// catchall and would retain unknown keys, defeating the lean projection.
export const CodexLeanModelSchema = CodexModelBaseSchema.pick({
  slug: true,
  display_name: true,
  priority: true,
  supported_in_api: true,
  visibility: true,
});

export type CodexLeanModel = z.infer<typeof CodexLeanModelSchema>;
```

```ts
// packages/types/src/codex-model/index.ts
export * from "./codex-model";
```

Also add to `packages/types/src/index.ts`:

```ts
export * from "./codex-model/index";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/types && bun test src/codex-model/codex-model.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/codex-model packages/types/src/index.ts
git commit -m "feat(types): add shared codex upstream model schema" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 2: Point openai-chatgpt plugin at the shared lean schema

**Files:**
- Modify: `packages/plugins/openai-chatgpt/package.json` (add `@aio-proxy/types` dependency)
- Modify: `packages/plugins/openai-chatgpt/src/catalog.ts`
- Test: `packages/plugins/openai-chatgpt/src/catalog.test.ts` (existing, keep green)

**Interfaces:**
- Consumes: `CodexLeanModelSchema` from `@aio-proxy/types`.
- Produces: no signature change to `discoverOpenAIChatGPTModels`; output remains `readonly ModelDescriptor[]`.

The plugin does not yet depend on `@aio-proxy/types`; add it before importing.

- [ ] **Step 0: Declare the workspace dependency**

Add to `packages/plugins/openai-chatgpt/package.json` `dependencies` (keep alphabetical among the `@aio-proxy/*` entries):

```json
"@aio-proxy/types": "workspace:*",
```

Then run `bun install` from the repo root so the workspace link resolves.

- [ ] **Step 1: Write the failing test**

Add to `packages/plugins/openai-chatgpt/src/catalog.test.ts`:

```ts
test("ignores unknown upstream fields while keeping lean projection", async () => {
  globalThis.fetch = async () =>
    Response.json({
      models: [
        {
          slug: "visible",
          display_name: "Visible",
          priority: 1,
          supported_in_api: true,
          visibility: "list",
          base_instructions: "x".repeat(20000),
          brand_new_field: true,
        },
      ],
    });

  await expect(discoverOpenAIChatGPTModels(new AbortController().signal)).resolves.toEqual([
    { id: "visible", displayName: "Visible", metadata: { protocol: "openai-response" } },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails or passes-by-luck**

Run: `cd packages/plugins/openai-chatgpt && bun test src/catalog.test.ts`
Expected: PASS is acceptable here (current schema already ignores unknowns); this test locks the behavior before we swap the schema source. If it FAILS, the current inline schema is stricter than expected — proceed to Step 3 regardless.

- [ ] **Step 3: Swap inline schema for the shared one**

In `packages/plugins/openai-chatgpt/src/catalog.ts`, replace the inline `CodexModelsSchema` with the shared lean schema:

```ts
import { type ModelDescriptor, zod } from "@aio-proxy/plugin-sdk";
import { CodexLeanModelSchema } from "@aio-proxy/types";
import { filter, map, pipe, sortBy } from "es-toolkit/fp";

export const CODEX_MODELS_URL =
  "https://github.com/openai/codex/raw/refs/heads/main/codex-rs/models-manager/models.json";
export const CHATGPT_CATALOG_TTL_MS = 6 * 60 * 60_000;

const CodexModelsSchema = zod.object({
  models: zod.array(CodexLeanModelSchema),
});
```

Leave the `discoverOpenAIChatGPTModels` body unchanged (it already reads `slug`/`display_name`/`priority`/`supported_in_api`/`visibility`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/plugins/openai-chatgpt && bun test src/catalog.test.ts`
Expected: PASS (all, including the pre-existing priority-order test).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/openai-chatgpt/package.json packages/plugins/openai-chatgpt/src/catalog.ts packages/plugins/openai-chatgpt/src/catalog.test.ts
git commit -m "refactor(openai-chatgpt): consume shared codex lean schema" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 3: Add `codexModelsCachePath()` to core paths

**Files:**
- Modify: `packages/core/src/paths/paths.ts`
- Modify: `packages/core/src/paths/index.ts` (re-export the new function)
- Modify: `packages/core/src/index.ts` (add to the `./paths/index` re-export list)
- Test: `packages/core/src/paths/paths.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Produces: `codexModelsCachePath(): string` returning `<aioHome>/codex_models_cache.json`, re-exported from `@aio-proxy/core`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/paths/paths.test.ts
import { afterEach, expect, test } from "bun:test";

import { codexModelsCachePath } from "./paths";

const original = process.env.AIO_PROXY_HOME;
afterEach(() => {
  if (original === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = original;
});

test("codexModelsCachePath honors AIO_PROXY_HOME", () => {
  process.env.AIO_PROXY_HOME = "/tmp/aio-home-test";
  expect(codexModelsCachePath()).toBe("/tmp/aio-home-test/codex_models_cache.json");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test src/paths/paths.test.ts`
Expected: FAIL — `codexModelsCachePath` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/paths/paths.ts`:

```ts
export function codexModelsCachePath(): string {
  return join(aioHome(), "codex_models_cache.json");
}
```

Add `codexModelsCachePath` to the re-export in `packages/core/src/paths/index.ts`:

```ts
export { aioHome, codexModelsCachePath, configPath, dbPath, logPath, packagesDir, pidPath } from "./paths";
```

Add `codexModelsCachePath` to the matching `./paths/index` re-export line in `packages/core/src/index.ts`:

```ts
export { aioHome, codexModelsCachePath, configPath, dbPath, logPath, packagesDir, pidPath } from "./paths/index";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun test src/paths/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/paths/paths.ts packages/core/src/paths/index.ts packages/core/src/index.ts packages/core/src/paths/paths.test.ts
git commit -m "feat(core): add codex models cache path" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 4: Shared model resolution layer

**Files:**
- Create: `packages/server/src/server/model-resolution/index.ts`
- Create: `packages/server/src/server/model-resolution/model-resolution.ts`
- Test: `packages/server/src/server/model-resolution/model-resolution.test.ts`

**Interfaces:**
- Consumes: `ServerState` (`acquireProviderSnapshot()`, `modelsDevCatalog()`), `modelRoutes` from `@aio-proxy/core`, `ModelsDevModelMetadata` from `@aio-proxy/core`, `RuntimeProviderInstance` from `../../runtime`.
- Produces:
  - `type ResolvedModel = { readonly slug: string; readonly modelId: string; readonly provider: RuntimeProviderInstance; readonly metadata: ModelsDevModelMetadata | undefined; readonly displayName: string }`.
  - `resolveEnabledModels(state: ServerState): Promise<readonly ResolvedModel[]>`.
  - Note: an alias is a fully self-contained public view. `metadata` and `displayName` come only from the alias slug's own catalog entry (plus OAuth provider self-reported name); the upstream `modelId` is never consulted for catalog metadata.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/server/model-resolution/model-resolution.test.ts
import { expect, test } from "bun:test";

import { ProviderKind } from "@aio-proxy/types";

import type { RuntimeProviderInstance } from "../../runtime";
import type { ServerState } from "../../server-state";

import { resolveEnabledModels } from "./model-resolution";

const oauthProvider = {
  id: "p1",
  kind: ProviderKind.OAuth,
  enabled: true,
  alias: { "gpt-5": { model: "gpt-5.6-sol", preserve: false } },
  modelMetadata: { "gpt-5.6-sol": { displayName: "Vendor Name" } },
  model: { invoke: async function* () {} },
} as unknown as RuntimeProviderInstance;

const aliasOnlyProvider = {
  id: "p2",
  kind: ProviderKind.Api,
  enabled: true,
  alias: { "my-alias": { model: "gpt-5.6-sol", preserve: false } },
  model: { invoke: async function* () {} },
} as unknown as RuntimeProviderInstance;

function fakeState(providers: readonly RuntimeProviderInstance[], catalog: unknown): ServerState {
  return {
    acquireProviderSnapshot: () => ({
      snapshot: { providers },
      release() {},
    }),
    modelsDevCatalog: async () => catalog,
  } as unknown as ServerState;
}

test("resolveEnabledModels reads metadata only from the alias slug, never the upstream modelId", async () => {
  // alias "my-alias" has no catalog entry; upstream "gpt-5.6-sol" does. The upstream
  // entry must NOT leak into the alias's public view.
  const catalog = {
    metadata: (id: string) =>
      id === "gpt-5.6-sol" ? { displayName: "Upstream Name", maxTokens: 999 } : undefined,
  };
  const resolved = await resolveEnabledModels(fakeState([aliasOnlyProvider], catalog));
  expect(resolved).toEqual([
    {
      slug: "my-alias",
      modelId: "gpt-5.6-sol",
      provider: aliasOnlyProvider,
      metadata: undefined,
      displayName: "my-alias",
    },
  ]);
});

test("resolveEnabledModels de-dupes by slug and uses alias-slug catalog metadata", async () => {
  const catalog = {
    metadata: (id: string) => (id === "gpt-5" ? { maxTokens: 100 } : { maxTokens: 999 }),
  };
  const resolved = await resolveEnabledModels(fakeState([oauthProvider], catalog));
  expect(resolved).toEqual([
    {
      slug: "gpt-5",
      modelId: "gpt-5.6-sol",
      provider: oauthProvider,
      metadata: { maxTokens: 100 },
      displayName: "Vendor Name",
    },
  ]);
});

test("displayName prefers the OAuth provider self-reported name for the upstream modelId", async () => {
  const resolved = await resolveEnabledModels(fakeState([oauthProvider], { metadata: () => undefined }));
  expect(resolved[0]?.displayName).toBe("Vendor Name");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test src/server/model-resolution/model-resolution.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/src/server/model-resolution/model-resolution.ts
import { type ModelsDevModelMetadata, modelRoutes } from "@aio-proxy/core";
import { filter, flatMap, map, pipe, uniqBy } from "es-toolkit/fp";

import type { RuntimeProviderInstance } from "../../runtime";
import type { ServerState } from "../../server-state";

export type ResolvedModel = {
  readonly slug: string;
  readonly modelId: string;
  readonly provider: RuntimeProviderInstance;
  readonly metadata: ModelsDevModelMetadata | undefined;
  readonly displayName: string;
};

// An alias is a fully self-contained public view: metadata is read only from the
// alias slug's own catalog entry, never from the upstream modelId. The upstream
// model's catalog name/capabilities/token limits must not leak to clients.
function resolveDisplayName(
  provider: RuntimeProviderInstance,
  modelId: string,
  slug: string,
  metadata: ModelsDevModelMetadata | undefined,
): string {
  return provider.modelMetadata?.[modelId]?.displayName ?? metadata?.displayName ?? slug;
}

export async function resolveEnabledModels(state: ServerState): Promise<readonly ResolvedModel[]> {
  const lease = state.acquireProviderSnapshot();
  try {
    const routes = pipe(
      lease.snapshot.providers,
      filter((provider) => provider.enabled),
      flatMap((provider) =>
        modelRoutes(provider).map((route) => ({ slug: route.alias, modelId: route.modelId, provider })),
      ),
      uniqBy(({ slug }) => slug),
    );

    const catalog = routes.length === 0 ? undefined : await state.modelsDevCatalog().catch(() => undefined);

    return map((route: { slug: string; modelId: string; provider: RuntimeProviderInstance }): ResolvedModel => {
      const metadata = catalog?.metadata(route.slug);
      return {
        slug: route.slug,
        modelId: route.modelId,
        provider: route.provider,
        metadata,
        displayName: resolveDisplayName(route.provider, route.modelId, route.slug, metadata),
      };
    })(routes);
  } finally {
    lease.release();
  }
}
```

```ts
// packages/server/src/server/model-resolution/index.ts
export { type ResolvedModel, resolveEnabledModels } from "./model-resolution";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test src/server/model-resolution/model-resolution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/model-resolution
git commit -m "feat(server): add shared model resolution layer" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 5: Refactor `listModels()` onto the shared layer

**Files:**
- Modify: `packages/server/src/server/server.ts`
- Test: reuse existing server route tests; add one if none asserts the list shape (see Step 1).

**Interfaces:**
- Consumes: `resolveEnabledModels` from `./model-resolution/index`.
- Produces: `listModels(state)` returns the identical OpenAI/Anthropic superset shape as before.

- [ ] **Step 1: Write/confirm the failing test (regression guard)**

Locate the existing `/v1/models` test. If present, run it as the guard. If absent, create `packages/server/src/server/server.models.test.ts`:

```ts
import { expect, test } from "bun:test";

import { resolveEnabledModels } from "./model-resolution";

test("resolveEnabledModels is the source for listModels projection", async () => {
  // Guard: listModels must not re-enumerate providers itself.
  expect(typeof resolveEnabledModels).toBe("function");
});
```

(Prefer the real route-level test if one already exists; this stub only guarantees the dependency edge exists before refactor.)

- [ ] **Step 2: Run the existing model list test to capture current output**

Run: `cd packages/server && bun test src/server` (note the current `/v1/models` assertions)
Expected: PASS (baseline before refactor).

- [ ] **Step 3: Refactor implementation**

In `packages/server/src/server/server.ts`:
- Import `resolveEnabledModels` from `./model-resolution/index`.
- Replace the body of `listModels` so it maps over `await resolveEnabledModels(state)`:

```ts
async function listModels(state: ServerState) {
  const resolved = await resolveEnabledModels(state);
  const data = resolved.map(({ slug, provider, metadata, displayName }): ModelListItem => {
    const timestamps = modelTimestamps(metadata?.releaseDate);
    return {
      capabilities: metadata?.capabilities ?? null,
      created: timestamps.created,
      created_at: timestamps.createdAt,
      display_name: displayName,
      id: slug,
      max_input_tokens: metadata?.maxInputTokens ?? null,
      max_tokens: metadata?.maxTokens ?? null,
      object: "model",
      owned_by: provider.id,
      type: "model",
    };
  });
  return {
    data,
    first_id: data[0]?.id ?? null,
    has_more: false,
    last_id: data.at(-1)?.id ?? null,
    object: "list" as const,
  };
}
```

- Delete the now-unused `modelDisplayName` function and the now-unused `filter/flatMap/map/pipe/uniqBy` imports if no longer referenced elsewhere in the file. Keep `modelTimestamps`.

- [ ] **Step 4: Run tests to verify no shape change**

Run: `cd packages/server && bun test src/server`
Expected: PASS — the `/v1/models` list output is byte-for-byte equivalent to baseline.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/server.ts packages/server/src/server/server.models.test.ts
git commit -m "refactor(server): project listModels from shared resolution" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 6: Generate the `default-instructions.md` snapshot

**Files:**
- Create: `packages/server/src/server/codex-client-models/default-instructions.md`

**Interfaces:**
- Produces: a markdown file containing the full 5.6 `base_instructions`, with the sole `GPT-5` occurrence in the opening line replaced by `{{model_name}}`.

- [ ] **Step 1: Fetch upstream and generate the file deterministically**

Run this one-shot generator (network required):

```bash
cd /Users/bytedance/.codex/worktrees/343c/aio-proxy
bun -e '
const url="https://github.com/openai/codex/raw/refs/heads/main/codex-rs/models-manager/models.json";
const j=await (await fetch(url)).json();
const m=j.models.find(x=>x.slug==="gpt-5.6-sol");
if(!m) throw new Error("gpt-5.6-sol not found upstream");
const text=m.base_instructions;
const count=(text.match(/GPT-5\b/g)||[]).length;
if(count!==1) throw new Error("expected exactly 1 GPT-5 token, got "+count);
const out=text.replace("based on GPT-5.", "based on {{model_name}}.");
if(!out.includes("{{model_name}}")) throw new Error("placeholder substitution failed");
await Bun.write("packages/server/src/server/codex-client-models/default-instructions.md", out);
console.log("written", out.length, "bytes");
'
```

- [ ] **Step 2: Verify the placeholder and size**

Run: `grep -c "{{model_name}}" packages/server/src/server/codex-client-models/default-instructions.md`
Expected: `1`. File size should be ~17.7KB.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/server/codex-client-models/default-instructions.md
git commit -m "chore(server): add codex 5.6 instructions snapshot fixture" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 7: File cache read/refresh

**Files:**
- Create: `packages/server/src/server/codex-client-models/codex-cache.ts`
- Test: `packages/server/src/server/codex-client-models/codex-cache.test.ts`

**Interfaces:**
- Consumes: `codexModelsCachePath` from `@aio-proxy/core`, `CodexUpstreamModelSchema` from `@aio-proxy/types`, `CODEX_MODELS_URL` + `CHATGPT_CATALOG_TTL_MS` (re-declare locally to avoid importing plugin internals; use the same URL constant and `6 * 60 * 60_000`).
- Produces: `readCodexModelsCache(options): Promise<readonly CodexUpstreamModel[]>` where `options = { now?: number; fetchImpl?: typeof fetch; cachePath?: string; ttlMs?: number }`. Reads the file; if missing or `fetched_at` older than `ttlMs`, downloads, writes `{ models, fetched_at: <ISO> }`, and returns `models`. On download failure with a present (stale) file, returns the stale `models`. On failure with no file, returns `[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/server/codex-client-models/codex-cache.test.ts
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCodexModelsCache } from "./codex-cache";

const dirs: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-cache-"));
  dirs.push(dir);
  return join(dir, "codex_models_cache.json");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const upstreamItem = {
  slug: "gpt-5.6-sol",
  display_name: "GPT-5.6-Sol",
  priority: 1,
  supported_in_api: true,
  visibility: "list",
  base_instructions: "text",
};

test("downloads and writes cache when file missing", async () => {
  const cachePath = tmpFile();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({ models: [upstreamItem] });
  }) as unknown as typeof fetch;

  const models = await readCodexModelsCache({ cachePath, fetchImpl, now: 1000 });
  expect(models.map((m) => m.slug)).toEqual(["gpt-5.6-sol"]);
  expect(calls).toBe(1);

  // fresh within ttl -> no second download
  const again = await readCodexModelsCache({ cachePath, fetchImpl, now: 1000 });
  expect(again.map((m) => m.slug)).toEqual(["gpt-5.6-sol"]);
  expect(calls).toBe(1);
});

test("returns [] when no file and download fails", async () => {
  const cachePath = tmpFile();
  const fetchImpl = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const models = await readCodexModelsCache({ cachePath, fetchImpl });
  expect(models).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test src/server/codex-client-models/codex-cache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/src/server/codex-client-models/codex-cache.ts
import { readFile, writeFile } from "node:fs/promises";

import { codexModelsCachePath } from "@aio-proxy/core";
import { type CodexUpstreamModel, CodexUpstreamModelSchema } from "@aio-proxy/types";
import { zod } from "@aio-proxy/plugin-sdk";

const CODEX_MODELS_URL =
  "https://github.com/openai/codex/raw/refs/heads/main/codex-rs/models-manager/models.json";
const DEFAULT_TTL_MS = 6 * 60 * 60_000;

const CacheFileSchema = zod.object({
  fetched_at: zod.string(),
  models: zod.array(CodexUpstreamModelSchema),
});

type ReadOptions = {
  readonly now?: number;
  readonly fetchImpl?: typeof fetch;
  readonly cachePath?: string;
  readonly ttlMs?: number;
};

export async function readCodexModelsCache(options: ReadOptions = {}): Promise<readonly CodexUpstreamModel[]> {
  const cachePath = options.cachePath ?? codexModelsCachePath();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;

  const cached = await readCacheFile(cachePath);
  if (cached !== undefined && now - Date.parse(cached.fetched_at) < ttlMs) {
    return cached.models;
  }

  try {
    const response = await fetchImpl(CODEX_MODELS_URL);
    if (!response.ok) throw new Error(`codex models request failed with ${response.status}`);
    const { models } = zod.object({ models: zod.array(CodexUpstreamModelSchema) }).parse(await response.json());
    await writeFile(cachePath, JSON.stringify({ models, fetched_at: new Date(now).toISOString() }), "utf8");
    return models;
  } catch {
    return cached?.models ?? [];
  }
}

async function readCacheFile(cachePath: string): Promise<{ fetched_at: string; models: readonly CodexUpstreamModel[] } | undefined> {
  try {
    const parsed = CacheFileSchema.parse(JSON.parse(await readFile(cachePath, "utf8")));
    return parsed;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test src/server/codex-client-models/codex-cache.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/codex-client-models/codex-cache.ts packages/server/src/server/codex-client-models/codex-cache.test.ts
git commit -m "feat(server): add codex models file cache" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 8: Case B assembly (synthesized entries)

**Files:**
- Create: `packages/server/src/server/codex-client-models/codex-assembly.ts`
- Test: `packages/server/src/server/codex-client-models/codex-assembly.test.ts`

**Interfaces:**
- Consumes: `ModelsDevModelMetadata` from `@aio-proxy/core`; the md snapshot via `import instructions from "./default-instructions.md" with { type: "text" }`.
- Produces: `assembleCodexModel(input: { slug: string; displayName: string; metadata: ModelsDevModelMetadata | undefined }): Record<string, unknown>` — a Codex-shaped entry with per-field zod defaults (from `gpt-5.6-sol`), structural fields overridden from `metadata` when present, `base_instructions` and `model_messages.instructions_template` set to the md text with `{{model_name}}` replaced by `slug`, and NO `availability_nux`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/server/codex-client-models/codex-assembly.test.ts
import { expect, test } from "bun:test";

import { assembleCodexModel } from "./codex-assembly";

test("synthesized entry substitutes model name and omits availability_nux", () => {
  const entry = assembleCodexModel({ slug: "my-alias", displayName: "My Alias", metadata: undefined });
  expect(entry.slug).toBe("my-alias");
  expect(entry.id).toBe("my-alias");
  expect(entry.display_name).toBe("My Alias");
  expect((entry.base_instructions as string).includes("based on my-alias.")).toBe(true);
  expect((entry.base_instructions as string).includes("{{model_name}}")).toBe(false);
  expect((entry.model_messages as { instructions_template: string }).instructions_template).toBe(
    entry.base_instructions,
  );
  expect("availability_nux" in entry).toBe(false);
});

test("reasoning levels derive from models-dev effort capabilities", () => {
  const entry = assembleCodexModel({
    slug: "m",
    displayName: "M",
    metadata: {
      maxInputTokens: 500,
      capabilities: {
        effort: { low: { supported: true }, medium: { supported: true }, high: { supported: false }, xhigh: { supported: false }, max: { supported: false }, supported: true },
        image_input: { supported: false },
        pdf_input: { supported: false },
        structured_outputs: { supported: false },
        thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
      },
    },
  });
  expect((entry.supported_reasoning_levels as { effort: string }[]).map((l) => l.effort)).toEqual(["low", "medium"]);
  expect(entry.context_window).toBe(500);
  expect(entry.input_modalities).toEqual(["text"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test src/server/codex-client-models/codex-assembly.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/src/server/codex-client-models/codex-assembly.ts
import type { ModelsDevModelMetadata } from "@aio-proxy/core";

import instructions from "./default-instructions.md" with { type: "text" };

const REASONING_DESCRIPTIONS: Record<string, string> = {
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
};

const DEFAULT_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"].map((effort) => ({
  effort,
  description: REASONING_DESCRIPTIONS[effort],
}));

const DEFAULT_CONTEXT_WINDOW = 272_000;

type AssembleInput = {
  readonly slug: string;
  readonly displayName: string;
  readonly metadata: ModelsDevModelMetadata | undefined;
};

export function assembleCodexModel(input: AssembleInput): Record<string, unknown> {
  const text = instructions.replaceAll("{{model_name}}", input.slug);
  const contextWindow = input.metadata?.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW;
  return {
    slug: input.slug,
    id: input.slug,
    display_name: input.displayName,
    context_window: contextWindow,
    max_context_window: contextWindow,
    input_modalities: inputModalities(input.metadata),
    supported_reasoning_levels: reasoningLevels(input.metadata),
    default_reasoning_level: "low",
    supports_search_tool: false,
    base_instructions: text,
    model_messages: { instructions_template: text, instructions_variables: {}, approvals: null },
  };
}

function inputModalities(metadata: ModelsDevModelMetadata | undefined): readonly string[] {
  const modalities = ["text"];
  if (metadata?.capabilities?.image_input?.supported) modalities.push("image");
  if (metadata?.capabilities?.pdf_input?.supported) modalities.push("pdf");
  return modalities;
}

function reasoningLevels(metadata: ModelsDevModelMetadata | undefined): readonly { effort: string; description: string }[] {
  const effort = metadata?.capabilities?.effort;
  if (effort === undefined || !effort.supported) return DEFAULT_REASONING_LEVELS;
  return (["low", "medium", "high", "xhigh", "max"] as const)
    .filter((level) => effort[level]?.supported)
    .map((level) => ({ effort: level, description: REASONING_DESCRIPTIONS[level] }));
}
```

Note: the spec calls for "each field its own zod schema with `.default()`". This minimal version uses plain object defaults for the fields we actually emit. If the reviewer wants the zod-default form, wrap each field in `zod.X().default(...)` and parse an empty object; the emitted shape and this test must stay identical. Keep the file <= 300 lines.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test src/server/codex-client-models/codex-assembly.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/codex-client-models/codex-assembly.ts packages/server/src/server/codex-client-models/codex-assembly.test.ts
git commit -m "feat(server): add codex case B assembly" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 9: Endpoint orchestration `codexClientModels`

**Files:**
- Create: `packages/server/src/server/codex-client-models/codex-client-models.ts`
- Create: `packages/server/src/server/codex-client-models/index.ts`
- Test: `packages/server/src/server/codex-client-models/codex-client-models.test.ts`

**Interfaces:**
- Consumes: `resolveEnabledModels` from `../model-resolution/index`; `readCodexModelsCache` from `./codex-cache`; `assembleCodexModel` from `./codex-assembly`; `ServerState`.
- Produces: `codexClientModels(state: ServerState, options?: { fetchImpl?: typeof fetch; cachePath?: string; now?: number }): Promise<{ models: readonly Record<string, unknown>[] }>`.
- Behavior: for each `ResolvedModel`, if the cache snapshot has an item whose `slug === resolved.modelId`, return that item verbatim with `slug` and `id` overwritten to `resolved.slug` (Case A). Otherwise `assembleCodexModel({ slug, displayName: resolved.displayName, metadata })` (Case B). Sort: Case A entries first, then ascending `priority` (Case B has no upstream priority → sort after, preserving resolution order).

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/server/codex-client-models/codex-client-models.test.ts
import { expect, test } from "bun:test";

import { ProviderKind } from "@aio-proxy/types";

import type { RuntimeProviderInstance } from "../../runtime";
import type { ServerState } from "../../server-state";

import { codexClientModels } from "./codex-client-models";

const provider = {
  id: "p1",
  kind: ProviderKind.OAuth,
  enabled: true,
  alias: {
    "gpt-5": { model: "gpt-5.6-sol", preserve: false },
    "my-alias": { model: "third-party-model", preserve: false },
  },
  modelMetadata: {},
  model: { invoke: async function* () {} },
} as unknown as RuntimeProviderInstance;

function fakeState(): ServerState {
  return {
    acquireProviderSnapshot: () => ({ snapshot: { providers: [provider] }, release() {} }),
    modelsDevCatalog: async () => undefined,
  } as unknown as ServerState;
}

const upstream = {
  slug: "gpt-5.6-sol",
  display_name: "GPT-5.6-Sol",
  priority: 1,
  supported_in_api: true,
  visibility: "list",
  base_instructions: "UPSTREAM VERBATIM",
  availability_nux: { message: "keep me" },
};

test("case A returns upstream verbatim with alias slug/id; case B synthesizes without availability_nux", async () => {
  const fetchImpl = (async () => Response.json({ models: [upstream] })) as unknown as typeof fetch;
  const { models } = await codexClientModels(fakeState(), {
    fetchImpl,
    cachePath: "/tmp/does-not-exist-codex-" + Math.random().toString(36).slice(2) + ".json",
    now: 0,
  });

  const caseA = models.find((m) => m.id === "gpt-5");
  expect(caseA?.slug).toBe("gpt-5");
  expect(caseA?.base_instructions).toBe("UPSTREAM VERBATIM");
  expect((caseA as { availability_nux?: unknown }).availability_nux).toEqual({ message: "keep me" });

  const caseB = models.find((m) => m.id === "my-alias");
  expect(caseB?.slug).toBe("my-alias");
  expect("availability_nux" in (caseB as object)).toBe(false);
  expect((caseB?.base_instructions as string).includes("based on my-alias.")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test src/server/codex-client-models/codex-client-models.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/src/server/codex-client-models/codex-client-models.ts
import type { ServerState } from "../../server-state";

import { resolveEnabledModels } from "../model-resolution/index";
import { assembleCodexModel } from "./codex-assembly";
import { readCodexModelsCache } from "./codex-cache";

type Options = { readonly fetchImpl?: typeof fetch; readonly cachePath?: string; readonly now?: number };

export async function codexClientModels(
  state: ServerState,
  options: Options = {},
): Promise<{ readonly models: readonly Record<string, unknown>[] }> {
  const [resolved, upstream] = await Promise.all([
    resolveEnabledModels(state),
    readCodexModelsCache(options),
  ]);
  const bySlug = new Map(upstream.map((item) => [item.slug, item]));

  const templated: { entry: Record<string, unknown>; priority: number }[] = [];
  const synthesized: Record<string, unknown>[] = [];

  for (const model of resolved) {
    const row = bySlug.get(model.modelId);
    if (row !== undefined) {
      templated.push({ entry: { ...row, slug: model.slug, id: model.slug }, priority: row.priority });
      continue;
    }
    synthesized.push(
      assembleCodexModel({
        slug: model.slug,
        displayName: model.displayName,
        metadata: model.metadata,
      }),
    );
  }

  templated.sort((a, b) => a.priority - b.priority);
  return { models: [...templated.map((t) => t.entry), ...synthesized] };
}
```

```ts
// packages/server/src/server/codex-client-models/index.ts
export { codexClientModels } from "./codex-client-models";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test src/server/codex-client-models/codex-client-models.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/codex-client-models/codex-client-models.ts packages/server/src/server/codex-client-models/index.ts packages/server/src/server/codex-client-models/codex-client-models.test.ts
git commit -m "feat(server): add codex client models orchestration" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 10: Wire the `/v1/models` query-key branch

**Files:**
- Modify: `packages/server/src/server/server.ts`
- Test: `packages/server/src/server/server.models.test.ts` (extend)

**Interfaces:**
- Consumes: `codexClientModels` from `./codex-client-models/index`.
- Behavior: `app.get("/v1/models")` returns `codexClientModels(state)` when the query string contains a `client_version` key (any value), else `listModels(state)`.

- [ ] **Step 1: Write the failing test**

Add a route-level test (Hono `app.request`) asserting both branches. If the server exposes a test harness for `createRoutes`, use it; otherwise assert at the handler-selection level:

```ts
import { expect, test } from "bun:test";

test("client_version query key selects codex catalog shape", () => {
  const url = new URL("http://x/v1/models?client_version=0.146.0");
  expect(url.searchParams.has("client_version")).toBe(true);
  const plain = new URL("http://x/v1/models");
  expect(plain.searchParams.has("client_version")).toBe(false);
});
```

(If a full route harness exists in the repo, prefer a request-level test that asserts `{"models":[...]}` vs `{object:"list"}`.)

- [ ] **Step 2: Run test to verify current wiring**

Run: `cd packages/server && bun test src/server/server.models.test.ts`
Expected: PASS for the URL guard; the real branch does not exist yet.

- [ ] **Step 3: Implement the branch**

In `packages/server/src/server/server.ts`, import and branch:

```ts
import { codexClientModels } from "./codex-client-models/index";
```

```ts
app.get("/v1/models", async (context) => {
  const url = new URL(context.req.url);
  if (url.searchParams.has("client_version")) {
    return context.json(await codexClientModels(state));
  }
  return context.json(await listModels(state));
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && bun test src/server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/server.ts packages/server/src/server/server.models.test.ts
git commit -m "feat(server): serve codex catalog on client_version probe" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 11: Full preflight

- [ ] **Step 1: Run the full gate**

Run: `bun run preflight`
Expected: oxlint clean, oxfmt clean, all unit tests pass.

- [ ] **Step 2: Fix any lint/format/type fallout inline, then re-run**

Run: `bun run preflight`
Expected: PASS.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "chore: preflight fixups for codex client models" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Trigger (`client_version` key) → Task 10.
- Codex response shape `{"models":[...]}` → Task 9/10.
- Standard list unchanged → Task 5 (regression) + Task 10 branch.
- Shared resolution layer (`ResolvedModel`, `resolveEnabledModels`) → Task 4; `listModels` refactor → Task 5.
- File cache at `~/.aio-proxy/codex_models_cache.json` with `{ ...resp, fetched_at }` → Task 3 (path) + Task 7 (read/refresh).
- Shared zod schema in types + plugin `.pick` → Task 1 + Task 2.
- Case A verbatim passthrough incl. `availability_nux` → Task 9.
- Case B field defaults + models-dev overrides, no `availability_nux` → Task 8.
- md snapshot with `{{model_name}}` substitution → Task 6 + Task 8.
- Error degradation (download fail → stale/[], Case B fallback) → Task 7 + Task 8.
- Three behavior tests → Task 8 (reasoning levels), Task 5/10 (standard shape), Task 9 (Case A verbatim + Case B no nux).

**2. Placeholder scan:** No TBD/TODO, no vague steps; every code step ships real code. All commit footers use `Co-authored-by: Codex <noreply@openai.com>`.

**3. Type consistency:** `ResolvedModel` fields (`slug`, `modelId`, `provider`, `metadata`, `displayName`) are used identically in Tasks 4/5/9. Tasks 5/9 read the precomputed `resolved.displayName` directly (no caller invokes `resolveDisplayName`, which is a private helper inside `model-resolution.ts`). `assembleCodexModel` input `{ slug, displayName, metadata }` matches its callers in Task 9. `readCodexModelsCache` option/return shapes match Task 9 usage.
