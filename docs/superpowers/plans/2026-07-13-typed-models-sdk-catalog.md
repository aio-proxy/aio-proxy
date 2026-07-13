# Typed models.dev SDK Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual models.dev JSON fetching with `@opencode-ai/models`, then enrich `/v1/models` with typed limits, partial capabilities, and release timestamps.

**Architecture:** Core owns one typed `Catalog` loader and converts SDK records into the existing shared pricing catalog plus normalized model metadata. Server keeps the existing six-hour shared promise cache, resolves metadata once per winning route, and shapes OpenAI/Anthropic-compatible response fields. Catalog failure remains non-fatal.

**Tech Stack:** Bun 1.3.14, TypeScript 6, `@opencode-ai/models@0.0.11`, `date-fns@^4.4.0`, Anthropic/OpenAI SDK response types, Bun test.

## Global Constraints

- Use `Models.make().catalog()`; do not fetch models.dev URLs directly.
- Preserve the existing six-hour server cache and shared pricing/model-list task.
- Use `limit.input ?? limit.context` for `max_input_tokens` and `limit.output` for `max_tokens`.
- Return only reliable capability fields: `effort`, `image_input`, `pdf_input`, `structured_outputs`, and `thinking`.
- Omit unknown capability fields rather than reporting `supported: false`.
- Parse release dates with date-fns; do not hand-write calendar parsing or Unix arithmetic.
- Catalog failure or missing metadata must preserve the current display-name, epoch, null-limit, and null-capability fallbacks.

---

### Task 1: Typed SDK Catalog and Metadata

**Files:**
- Modify: `package.json`
- Modify: `packages/core/package.json`
- Modify: `packages/core/src/usage-pricing.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/_test/usage-pricing.test.ts`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: `Catalog`, `Model`, `ModelMetadata`, and `Models.make()` from `@opencode-ai/models`.
- Produces: `FetchModelsDevCatalog`, `ModelsDevCapabilities`, `ModelsDevModelMetadata`, and `ModelsDevCatalog.metadata(modelId)`.

- [ ] **Step 1: Add failing typed metadata tests**

Replace the untyped `api` fixtures with `Catalog` fixtures. Add assertions equivalent to:

```ts
const metadata = catalog.metadata("gpt-5.5");
expect(metadata).toMatchObject({
  displayName: "GPT-5.5",
  maxInputTokens: 120_000,
  maxTokens: 8_000,
  releaseDate: "2026-01-15",
  capabilities: {
    effort: {
      supported: true,
      low: { supported: true },
      medium: { supported: true },
      high: { supported: true },
      max: { supported: false },
      xhigh: { supported: false },
    },
    image_input: { supported: true },
    pdf_input: { supported: true },
    structured_outputs: { supported: true },
    thinking: {
      supported: true,
      types: {
        adaptive: { supported: true },
        enabled: { supported: true },
      },
    },
  },
});
```

Add a Claude fixture without `limit.input` and assert `maxInputTokens` falls back to `limit.context`. Preserve the OpenRouter pricing assertions.

- [ ] **Step 2: Run the core test and verify RED**

Run:

```bash
rtk bun test packages/core/_test/usage-pricing.test.ts
```

Expected: FAIL because `ModelsDevCatalog.metadata` does not exist and the loader still accepts the old `api.json` shape.

- [ ] **Step 3: Add dependencies and generate the lockfile**

Add to the root workspace catalog:

```json
"@opencode-ai/models": "0.0.11"
```

Add to `packages/core/package.json` dependencies:

```json
"@opencode-ai/models": "catalog:"
```

Run:

```bash
rtk bun install
```

- [ ] **Step 4: Implement the typed catalog loader**

In `usage-pricing.ts`, define:

```ts
import { Models, type Catalog, type Model, type ModelMetadata } from "@opencode-ai/models";
import type { ModelCapabilities } from "@anthropic-ai/sdk/resources/models";

export type FetchModelsDevCatalog = () => Promise<Catalog>;
export type ModelsDevCapabilities = Pick<
  ModelCapabilities,
  "effort" | "image_input" | "pdf_input" | "structured_outputs" | "thinking"
>;
export type ModelsDevModelMetadata = {
  readonly displayName?: string;
  readonly maxInputTokens?: number;
  readonly maxTokens?: number;
  readonly capabilities?: ModelsDevCapabilities;
  readonly releaseDate?: string;
};
export type ModelsDevCatalog = OpenRouterPriceCatalog & {
  readonly metadata: (modelId: string) => ModelsDevModelMetadata | undefined;
};
```

Create one stateless SDK client and typed default loader:

```ts
const modelsDev = Models.make();
const defaultFetch: FetchModelsDevCatalog = () => modelsDev.catalog();
```

Use `catalog.providers.openrouter?.models` for pricing. Resolve metadata by canonical key first (`openai/<id>`, `anthropic/<id>`, or an already-qualified ID), then use provider-scoped candidates with the existing first-provider/canonical and unambiguous-fallback rules.

Map provider records with helpers equivalent to:

```ts
const support = (supported: boolean) => ({ supported });

function modelCapabilities(model: Model): ModelsDevCapabilities {
  const options = model.reasoning_options ?? [];
  const effort = options.find((option) => option.type === "effort");
  const enabled = options.some((option) => option.type === "budget_tokens" || option.type === "toggle");
  const values = effort?.values ?? [];
  return {
    effort: {
      supported: effort !== undefined,
      low: support(values.includes("low")),
      medium: support(values.includes("medium")),
      high: support(values.includes("high")),
      max: support(values.includes("max")),
      xhigh: support(values.includes("xhigh")),
    },
    image_input: support(model.modalities.input.includes("image")),
    pdf_input: support(model.modalities.input.includes("pdf")),
    structured_outputs: support(model.structured_output === true),
    thinking: {
      supported: model.reasoning,
      types: {
        adaptive: support(effort !== undefined),
        enabled: support(enabled),
      },
    },
  };
}
```

Prefer provider-agnostic `ModelMetadata` for canonical name and release date, and provider `Model` for limits and reasoning options. Export the new types from `packages/core/src/index.ts`; replace `FetchOpenRouterPrices` usages with `FetchModelsDevCatalog`.

- [ ] **Step 5: Run the core test and verify GREEN**

Run:

```bash
rtk bun test packages/core/_test/usage-pricing.test.ts
```

Expected: all tests pass, including pricing, canonical metadata, context fallback, and capability mapping.

- [ ] **Step 6: Commit the typed catalog**

```bash
rtk git add package.json packages/core/package.json packages/core/src/usage-pricing.ts packages/core/src/index.ts packages/core/_test/usage-pricing.test.ts bun.lock
rtk git commit -m "feat(core): use typed models.dev catalog" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Enrich the Model List Response

**Files:**
- Modify: `packages/server/package.json`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/_test/server.test.ts`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: `ModelsDevCatalog.metadata`, `ModelsDevCapabilities`, `ModelsDevModelMetadata`.
- Produces: `/v1/models` entries with release timestamps, limits, and partial capabilities.

- [ ] **Step 1: Write failing response tests**

Extend `expectedModel` with optional metadata:

```ts
const expectedModel = (
  id: string,
  ownedBy: string,
  displayName: string = id,
  metadata: {
    readonly capabilities?: ModelsDevCapabilities;
    readonly created?: number;
    readonly createdAt?: string;
    readonly maxInputTokens?: number;
    readonly maxTokens?: number;
  } = {},
) => ({
  capabilities: metadata.capabilities ?? null,
  created: metadata.created ?? 0,
  created_at: metadata.createdAt ?? "1970-01-01T00:00:00Z",
  display_name: displayName,
  id,
  max_input_tokens: metadata.maxInputTokens ?? null,
  max_tokens: metadata.maxTokens ?? null,
  object: "model",
  owned_by: ownedBy,
  type: "model",
});
```

Update the weighted-provider catalog stub to implement `metadata()`. Assert a release date such as `2026-01-15` produces `created_at: "2026-01-15T00:00:00.000Z"` and `created: 1768435200`, plus limits and partial capabilities.

Add an OAuth alias case where the OAuth display name wins but catalog limits, capability subset, and release timestamps are still used. Add a malformed release date case that retains epoch timestamps.

- [ ] **Step 2: Run model-list tests and verify RED**

Run:

```bash
rtk bun test packages/server/_test/server.test.ts --test-name-pattern "models"
```

Expected: FAIL because response fields are still null/epoch and OAuth-only lists skip catalog loading.

- [ ] **Step 3: Add date-fns and implement response enrichment**

Add to `packages/server/package.json` dependencies:

```json
"date-fns": "^4.4.0"
```

Run `rtk bun install`.

Override the SDK capability type on model-list entries:

```ts
type ModelListItem = OpenAIModel &
  Omit<AnthropicModelInfo, "capabilities"> & {
    readonly capabilities: ModelsDevCapabilities | null;
  };
```

Resolve catalog metadata for every non-empty selected list, including OAuth-only lists:

```ts
const catalog = selected.length === 0 ? undefined : await state.modelsDevCatalog().catch(() => undefined);
```

Within the response `map`, resolve once:

```ts
const metadata = catalog?.metadata(id) ?? catalog?.metadata(modelId);
const timestamp = modelTimestamps(metadata?.releaseDate);
```

Use date-fns for timestamps:

```ts
import { getUnixTime, isValid, parseISO } from "date-fns";

function modelTimestamps(releaseDate: string | undefined): { readonly created: number; readonly createdAt: string } {
  if (releaseDate === undefined) return { created: 0, createdAt: unknownCreatedAt };
  const date = parseISO(`${releaseDate}T00:00:00Z`);
  if (!isValid(date)) return { created: 0, createdAt: unknownCreatedAt };
  return { created: getUnixTime(date), createdAt: date.toISOString() };
}
```

Keep OAuth display-name precedence, then use catalog display name, then route ID. Fill limits and partial capabilities from resolved metadata, falling back to null.

- [ ] **Step 4: Run model-list tests and verify GREEN**

Run:

```bash
rtk bun test packages/server/_test/server.test.ts --test-name-pattern "models"
```

Expected: all model-list tests pass.

- [ ] **Step 5: Run the full server test file**

Run:

```bash
rtk bun test packages/server/_test/server.test.ts
```

Expected: all server route tests pass.

- [ ] **Step 6: Commit response enrichment**

```bash
rtk git add packages/server/package.json packages/server/src/server.ts packages/server/_test/server.test.ts bun.lock
rtk git commit -m "feat(server): enrich model catalog metadata" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Shared Cache Regression and Repository Verification

**Files:**
- Modify: `packages/server/src/server-state.ts`
- Modify: `packages/server/_test/models-dev-catalog.test.ts`
- Modify: `docs/superpowers/specs/2026-07-13-model-list-protocol-superset-design.md`

**Interfaces:**
- Consumes: `FetchModelsDevCatalog` and the SDK `Catalog` fixture shape.
- Produces: one six-hour shared live-catalog request for pricing and model metadata.

- [ ] **Step 1: Update the cache test to a typed catalog fixture**

Change `createModelsDevCatalogTask` to accept `FetchModelsDevCatalog`. Update the injected fixture to return:

```ts
{
  models: {
    "openai/gpt-5.5": {
      id: "openai/gpt-5.5",
      name: "GPT-5.5",
      description: "",
      release_date: "2026-01-15",
      limit: { context: 128_000, input: 120_000, output: 8_000 },
    },
  },
  providers: {
    openai: {
      id: "openai",
      env: ["OPENAI_API_KEY"],
      npm: "@ai-sdk/openai",
      name: "OpenAI",
      doc: "https://platform.openai.com/docs/models",
      models: {
        "gpt-5.5": {
          id: "gpt-5.5",
          name: "GPT-5.5",
          description: "",
          attachment: true,
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
          tool_call: true,
          structured_output: true,
          temperature: false,
          release_date: "2026-01-15",
          last_updated: "2026-01-15",
          modalities: { input: ["text", "image", "pdf"], output: ["text"] },
          open_weights: false,
          limit: { context: 128_000, input: 120_000, output: 8_000 },
        },
      },
    },
    openrouter: {
      id: "openrouter",
      env: ["OPENROUTER_API_KEY"],
      npm: "@openrouter/ai-sdk-provider",
      name: "OpenRouter",
      doc: "https://openrouter.ai/models",
      models: {
        "openai/gpt-5.5": {
          id: "openai/gpt-5.5",
          name: "GPT-5.5",
          description: "",
          attachment: true,
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
          tool_call: true,
          structured_output: true,
          temperature: false,
          release_date: "2026-01-15",
          last_updated: "2026-01-15",
          modalities: { input: ["text", "image", "pdf"], output: ["text"] },
          open_weights: false,
          limit: { context: 128_000, input: 120_000, output: 8_000 },
          cost: { input: 2, output: 10 },
        },
      },
    },
  },
} satisfies Catalog
```

Assert metadata lookup and usage pricing still cause exactly one loader call.

- [ ] **Step 2: Run the cache test**

Run:

```bash
rtk bun test packages/server/_test/models-dev-catalog.test.ts
```

Expected: PASS with `fetches === 1`.

- [ ] **Step 3: Update the original model-list design document**

Revise the earlier response-shape section so token limits, partial capabilities, and release timestamps are no longer documented as permanently null/epoch. Link to `2026-07-13-models-sdk-catalog-design.md` for the detailed mapping rules.

- [ ] **Step 4: Run focused regression tests**

```bash
rtk bun test packages/core/_test/usage-pricing.test.ts packages/server/_test/models-dev-catalog.test.ts packages/server/_test/server.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 5: Run repository verification**

```bash
rtk bun run test:unit
rtk bun run check
rtk bun run build
rtk git diff --check
```

Expected: every command exits 0; `check` may retain only the repository's existing informational diagnostics and warning.

- [ ] **Step 6: Inspect final state and commit**

```bash
rtk git status --short
rtk git diff --stat HEAD~3..HEAD
rtk git add packages/server/src/server-state.ts packages/server/_test/models-dev-catalog.test.ts docs/superpowers/specs/2026-07-13-model-list-protocol-superset-design.md
rtk git commit -m "test(server): verify typed models.dev cache" -m "Co-authored-by: Codex <noreply@openai.com>"
```

Expected: the worktree is clean after the final commit.
