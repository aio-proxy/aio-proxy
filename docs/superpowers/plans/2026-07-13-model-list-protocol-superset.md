# Model List Protocol Superset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `GET /v1/models` return a deduplicated OpenAI/Anthropic response superset whose owner follows provider routing priority and whose display names come from OAuth metadata or the shared models.dev catalog.

**Architecture:** Extend the existing models.dev pricing parser into a general catalog that prefers canonical OpenAI/Anthropic names and otherwise resolves unambiguous display names, then share its existing six-hour server cache with `/v1/models`. Preserve OAuth vendor model records on runtime providers, and keep HTTP aggregation in `server.ts` while continuing to consume core `modelRoutes()`.

**Tech Stack:** TypeScript 6, Bun test runner, Hono, Zod-normalized provider configuration.

## Global Constraints

- Include client-facing routes from every enabled provider kind and protocol.
- Aggregate by client-facing model id; the first provider in routing priority order wins.
- Provider configuration remains sorted by descending `weight`, with configuration order preserved for ties.
- Return the complete field union of OpenAI `Model`/`Page` and Anthropic `ModelInfo`/`Page`.
- OAuth display names come from vendor metadata keyed by upstream model id.
- Non-OAuth display names use models.dev alias-first, then upstream-id lookup.
- Canonical OpenAI/Anthropic catalog entries win over differently formatted proxy names.
- Missing, conflicting fallback, or failed metadata lookup falls back to the client-facing id.
- Reuse one models.dev fetch/cache path for pricing and model metadata.
- Add no dependencies and do no unrelated refactoring.

---

## File Structure

- `packages/core/src/usage-pricing.ts`: parse one models.dev payload into pricing and display-name lookups.
- `packages/core/src/index.ts`: export the general models.dev catalog API.
- `packages/core/_test/usage-pricing.test.ts`: prove name resolution, ambiguity handling, and unchanged pricing.
- `packages/server/src/runtime.ts`: define optional normalized runtime model metadata.
- `packages/server/src/oauth-chatgpt-runtime.ts`: retain ChatGPT OAuth display names.
- `packages/server/src/oauth-runtime.ts`: retain cached GitHub Copilot display names.
- `packages/server/_test/oauth-chatgpt-runtime.test.ts`: prove ChatGPT runtime metadata.
- `packages/server/_test/oauth-provider-runtime.test.ts`: prove Copilot runtime metadata.
- `packages/server/src/server-state.ts`: expose one cached models.dev task to pricing and routes.
- `packages/server/src/server.ts`: aggregate routes and shape the protocol-superset response.
- `packages/server/_test/server.test.ts`: prove deduplication, priority, full fields, display names, fallback, and empty output.

### Task 1: Generalize The models.dev Catalog

**Files:**

- Modify: `packages/core/_test/usage-pricing.test.ts`
- Modify: `packages/core/src/usage-pricing.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Consumes: the existing `FetchOpenRouterPrices` callback and models.dev JSON payload.
- Produces: `ModelsDevCatalog extends OpenRouterPriceCatalog` with `displayName(modelId: string): string | undefined`, plus `createModelsDevCatalog(fetchJson?)`.

- [x] **Step 1: Write failing display-name catalog tests**

Add a models.dev fixture with canonical, raw, qualified, and conflicting names, then add:

```ts
test("prefers the canonical provider name across conflicting provider entries", async () => {
  const catalog = await createModelsDevCatalog(async () => modelsDevApi);

  expect(catalog.displayName("gpt-5.5")).toBe("GPT-5.5");
  expect(catalog.displayName("openai/gpt-5.5")).toBe("GPT-5.5");
});

test("rejects conflicting human-readable names", async () => {
  const catalog = await createModelsDevCatalog(async () => conflictingModelsDevApi);

  expect(catalog.displayName("shared-model")).toBeUndefined();
});
```

Keep the existing full-id and bare-id price assertions unchanged.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
rtk bun test packages/core/_test/usage-pricing.test.ts
```

Expected: FAIL because `createModelsDevCatalog` is not exported.

- [x] **Step 3: Implement the general catalog**

Add these public types and constructor in `usage-pricing.ts`:

```ts
export type ModelsDevCatalog = OpenRouterPriceCatalog & {
  readonly displayName: (modelId: string) => string | undefined;
};

export async function createModelsDevCatalog(
  fetchJson: FetchOpenRouterPrices = defaultFetch,
): Promise<ModelsDevCatalog> {
  const value = await fetchJson();
  const prices = parsePrices(value);
  const byId = new Map(prices.map((price) => [price.id, price]));
  const byBareId = uniqueBarePrices(prices);
  const displayNames = parseDisplayNames(value);

  return {
    displayName(modelId) {
      return displayNames.get(modelId);
    },
    find(modelId) {
      return byId.get(modelId) ?? byBareId.get(modelId);
    },
  };
}

export async function createOpenRouterPriceCatalog(
  fetchJson: FetchOpenRouterPrices = defaultFetch,
): Promise<OpenRouterPriceCatalog> {
  return createModelsDevCatalog(fetchJson);
}
```

Move the existing bare-price indexing into `uniqueBarePrices()`. Implement display-name parsing without schema dependencies:

```ts
function parseDisplayNames(value: unknown): ReadonlyMap<string, string> {
  const candidates = new Map<string, Set<string>>();
  if (!isRecord(value)) return new Map();

  for (const provider of Object.values(value)) {
    if (!isRecord(provider) || !isRecord(provider["models"])) continue;
    for (const model of Object.values(provider["models"])) {
      if (!isRecord(model) || typeof model["id"] !== "string" || typeof model["name"] !== "string") continue;
      if (model["name"] === model["id"]) continue;
      addDisplayName(candidates, model["id"], model["name"]);
      const bareId = model["id"].split("/").at(-1) ?? model["id"];
      addDisplayName(candidates, bareId, model["name"]);
    }
  }

  return new Map(
    [...candidates].flatMap(([modelId, names]) =>
      names.size === 1 ? [[modelId, [...names][0] as string] as const] : [],
    ),
  );
}

function addDisplayName(candidates: Map<string, Set<string>>, modelId: string, name: string): void {
  const names = candidates.get(modelId) ?? new Set<string>();
  names.add(name);
  candidates.set(modelId, names);
}
```

Retain provider-scoped name maps while parsing. `displayName()` first resolves qualified ids by their provider prefix, maps recognized `gpt-*`, `o*`, and other OpenAI families to the canonical `openai` entry, maps `claude-*` to `anthropic`, and only then uses the unambiguous cross-provider fallback map.

Export `createModelsDevCatalog` and `ModelsDevCatalog` from `packages/core/src/index.ts`.

- [x] **Step 4: Run tests and build core to verify GREEN**

Run:

```bash
rtk bun test packages/core/_test/usage-pricing.test.ts
rtk bun run --filter @aio-proxy/core build
```

Expected: all usage-pricing tests pass and the core build exits 0.

- [x] **Step 5: Commit the catalog change**

```bash
rtk git add packages/core/src/usage-pricing.ts packages/core/src/index.ts packages/core/_test/usage-pricing.test.ts
rtk git commit -m "feat(core): expose models.dev model metadata" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Preserve OAuth Display Names At Runtime

**Files:**

- Modify: `packages/server/src/runtime.ts`
- Modify: `packages/server/src/oauth-chatgpt-runtime.ts`
- Modify: `packages/server/src/oauth-runtime.ts`
- Modify: `packages/server/_test/oauth-chatgpt-runtime.test.ts`
- Modify: `packages/server/_test/oauth-provider-runtime.test.ts`

**Interfaces:**

- Consumes: OAuth provider model records containing `id` and optional `displayName`.
- Produces: `RuntimeProviderInstance.modelMetadata?: Readonly<Record<ModelId, RuntimeModelMetadata>>`.

- [x] **Step 1: Write failing OAuth metadata tests**

For ChatGPT runtime, add:

```ts
expect(instance.modelMetadata?.["gpt-5.4-mini"]).toEqual({ displayName: "GPT-5.4 mini" });
```

For Copilot, include `displayName` in cached auth models and add:

```ts
expect(provider?.modelMetadata).toMatchObject({
  "gpt-5-mini": { displayName: "GPT 5 Mini" },
  "claude-sonnet-4": { displayName: "Claude Sonnet 4" },
});
```

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
rtk bun test packages/server/_test/oauth-chatgpt-runtime.test.ts --test-name-pattern "bare config auto-exposes"
rtk bun test packages/server/_test/oauth-provider-runtime.test.ts --test-name-pattern "derives self-alias routes"
```

Expected: FAIL because runtime providers do not expose `modelMetadata`.

- [x] **Step 3: Add runtime metadata types and populate ChatGPT metadata**

Add in `runtime.ts`:

```ts
export type RuntimeModelMetadata = {
  readonly displayName?: string;
};

export type RuntimeProviderInstance = LegacyRuntimeProviderInstance &
  RuntimeCapabilities & {
    readonly modelMetadata?: Readonly<Record<ModelId, RuntimeModelMetadata>>;
  };
```

Insert this field in the existing `OAuthProviderInstance` declaration so its concrete constructors accept the metadata property:

```ts
readonly modelMetadata?: Readonly<Record<ModelId, RuntimeModelMetadata>>;
```

Add to the ChatGPT runtime return object:

```ts
modelMetadata: Object.fromEntries(
  OPENAI_CHATGPT_MODELS.map(({ id, displayName }) => [id, { displayName }]),
),
```

- [x] **Step 4: Preserve cached Copilot display names**

Extend `CachedCopilotModel`:

```ts
type CachedCopilotModel = {
  readonly id: string;
  readonly displayName?: string;
  readonly transport: CopilotTransport;
};
```

Accept `displayName` only when it is a string in `cachedCopilotModels()`. Ignore malformed values while retaining entries with a valid `id` and `transport` as routable, then add valid names to the returned provider:

```ts
modelMetadata: Object.fromEntries(
  (cachedModels ?? []).map(({ id, displayName }) => [
    id,
    displayName === undefined ? {} : { displayName },
  ]),
),
```

- [x] **Step 5: Run OAuth tests and verify GREEN**

Run:

```bash
rtk bun test packages/server/_test/oauth-chatgpt-runtime.test.ts packages/server/_test/oauth-provider-runtime.test.ts
```

Expected: all OAuth runtime tests pass.

- [x] **Step 6: Commit OAuth metadata**

```bash
rtk git add packages/server/src/runtime.ts packages/server/src/oauth-chatgpt-runtime.ts packages/server/src/oauth-runtime.ts packages/server/_test/oauth-chatgpt-runtime.test.ts packages/server/_test/oauth-provider-runtime.test.ts
rtk git commit -m "feat(server): preserve oauth model metadata" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Return The Deduplicated Protocol Superset

**Files:**

- Modify: `packages/server/src/server-state.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/_test/server.test.ts`

**Interfaces:**

- Consumes: `ModelsDevCatalog`, `RuntimeProviderInstance.modelMetadata`, and `modelRoutes(provider)`.
- Produces: `ServerState.modelsDevCatalog(): Promise<ModelsDevCatalog | undefined>` and the final `/v1/models` response.

- [x] **Step 1: Add expected-response test helpers**

Add in `server.test.ts`:

```ts
const expectedModel = (id: string, ownedBy: string, displayName: string = id) => ({
  capabilities: null,
  created: 0,
  created_at: "1970-01-01T00:00:00Z",
  display_name: displayName,
  id,
  max_input_tokens: null,
  max_tokens: null,
  object: "model",
  owned_by: ownedBy,
  type: "model",
});

const expectedModelList = (data: ReturnType<typeof expectedModel>[]) => ({
  data,
  first_id: data[0]?.id ?? null,
  has_more: false,
  last_id: data.at(-1)?.id ?? null,
  object: "list",
});
```

Update existing exact `/v1/models` assertions to use these helpers and inject `modelsDevCatalogTask: async () => undefined` for non-OAuth cases.

- [x] **Step 2: Write the failing aggregation and metadata tests**

Add one test with a lower-weight provider declared first and a higher-weight provider declared second. Both expose `shared`; the higher provider also exposes a canonical Claude alias for an opaque target, while the lower provider exposes an OpenAI-only model. Inject this catalog:

```ts
const catalog: ModelsDevCatalog = {
  displayName(modelId) {
    return {
      "claude-sonnet-4-6": "Claude Sonnet 4.6",
      "gpt-only": "GPT Only",
      shared: "Shared Model",
    }[modelId];
  },
  find() {
    return undefined;
  },
};
```

Assert the response equals:

```ts
expectedModelList([
  expectedModel("claude-sonnet-4-6", "high", "Claude Sonnet 4.6"),
  expectedModel("shared", "high", "Shared Model"),
  expectedModel("gpt-only", "low", "GPT Only"),
]);
```

Add a same-weight duplicate test that expects the first configured provider to own the model. Add a catalog-rejection test that still returns `expectedModel(id, owner)`. Update the ChatGPT OAuth endpoint test to assert `GPT-5.4 mini` is returned from OAuth metadata. Update the disabled-provider test to expect `expectedModelList([])`.

- [x] **Step 3: Run the server model tests and verify RED**

Run:

```bash
rtk bun test packages/server/_test/server.test.ts --test-name-pattern "models are requested|OpenAI models are requested|model list|disabled provider"
```

Expected: FAIL because duplicates remain and superset/catalog fields are missing.

- [x] **Step 4: Share the cached models.dev task through server state**

Import `createModelsDevCatalog` and `ModelsDevCatalog` in `server-state.ts`. Add to `ServerStateOptions`:

```ts
readonly modelsDevCatalogTask?: () => Promise<ModelsDevCatalog | undefined>;
```

Add to `ServerState`:

```ts
readonly modelsDevCatalog: () => Promise<ModelsDevCatalog | undefined>;
```

Replace the price-only task initialization with:

```ts
const modelsDevCatalog = options.modelsDevCatalogTask ?? createModelsDevCatalogTask();
const usageCapture = createUsageCapture({ priceCatalogTask: modelsDevCatalog });
```

Return `modelsDevCatalog` on the state object. Rename the private cache constructor and keep the six-hour behavior:

```ts
function createModelsDevCatalogTask(): () => Promise<ModelsDevCatalog | undefined> {
  let cached:
    | { readonly expiresAt: number; readonly task: Promise<ModelsDevCatalog | undefined> }
    | undefined;

  return () => {
    const now = Date.now();
    if (cached === undefined || cached.expiresAt <= now) {
      cached = {
        expiresAt: now + PRICE_CATALOG_TTL_MS,
        task: createModelsDevCatalog().catch((error: unknown) => {
          if (error instanceof Error) return undefined;
          throw error;
        }),
      };
    }
    return cached.task;
  };
}
```

Add `modelsDevCatalogTask` to `CreateServerOptions` and pass it through to `createServerState()`.

- [x] **Step 5: Implement model aggregation and response shaping**

Replace the inline route body with an async helper:

```ts
app.get("/v1/models", async (context) => context.json(await listModels(state)));
```

Add:

```ts
const unknownCreatedAt = "1970-01-01T00:00:00Z";

async function listModels(state: ServerState) {
  const selected = new Map<
    string,
    { readonly modelId: string; readonly provider: RuntimeProviderInstance }
  >();

  for (const provider of state.currentProviderSnapshot().providers) {
    if (!provider.enabled) continue;
    for (const route of modelRoutes(provider)) {
      if (!selected.has(route.alias)) {
        selected.set(route.alias, { modelId: route.modelId, provider });
      }
    }
  }

  const needsCatalog = [...selected.values()].some(({ provider }) => provider.kind !== ProviderKind.OAuth);
  const catalog = needsCatalog ? await state.modelsDevCatalog().catch(() => undefined) : undefined;
  const data = [...selected].map(([id, route]) => ({
    capabilities: null,
    created: 0,
    created_at: unknownCreatedAt,
    display_name: displayName(id, route.modelId, route.provider, catalog),
    id,
    max_input_tokens: null,
    max_tokens: null,
    object: "model" as const,
    owned_by: route.provider.id,
    type: "model" as const,
  }));

  return {
    data,
    first_id: data[0]?.id ?? null,
    has_more: false,
    last_id: data.at(-1)?.id ?? null,
    object: "list" as const,
  };
}

function displayName(
  id: string,
  modelId: string,
  provider: RuntimeProviderInstance,
  catalog: ModelsDevCatalog | undefined,
): string {
  if (provider.kind === ProviderKind.OAuth) {
    return provider.modelMetadata?.[modelId]?.displayName ?? id;
  }
  return catalog?.displayName(id) ?? catalog?.displayName(modelId) ?? id;
}
```

Change the existing core import in `server.ts` to import `modelRoutes` plus `type ModelsDevCatalog`, and change the types import to import `ProviderKind` alongside `ConfigSchema`. Import `type ModelsDevCatalog` and `createModelsDevCatalog` from `@aio-proxy/core` in `server-state.ts`.

- [x] **Step 6: Run focused server tests and verify GREEN**

Run:

```bash
rtk bun run --filter @aio-proxy/core build
rtk bun test packages/server/_test/server.test.ts
```

Expected: all server route tests pass with no live models.dev dependency.

- [x] **Step 7: Commit the endpoint change**

```bash
rtk git add packages/server/src/server-state.ts packages/server/src/server.ts packages/server/_test/server.test.ts
rtk git commit -m "feat(server): return model list protocol superset" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Verify The Complete Change

**Files:**

- Verify: all files changed in Tasks 1-3.

**Interfaces:**

- Consumes: completed core catalog, OAuth metadata, and model-list endpoint.
- Produces: fresh verification evidence for the final handoff.

- [x] **Step 1: Run focused regression tests**

```bash
rtk bun test packages/core/_test/usage-pricing.test.ts packages/server/_test/oauth-chatgpt-runtime.test.ts packages/server/_test/oauth-provider-runtime.test.ts packages/server/_test/server.test.ts
```

Expected: all focused tests pass with zero failures.

- [x] **Step 2: Run repository verification**

```bash
rtk bun run test:unit
rtk bun run check
rtk bun run build
rtk git diff --check
```

Expected: every command exits 0; tests report zero failures; formatting/type/build checks report no new diagnostics.

- [x] **Step 3: Inspect final state**

```bash
rtk git status --short
rtk git log -6 --oneline
```

Expected: the worktree is clean and the three implementation commits follow the design and plan commits.
