# Model List And Routing Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make configured API and AI SDK `models` routable and visible unless an alias or variant deliberately replaces the original model id without preservation.

**Architecture:** Keep client-facing model route construction in `packages/core/src/router.ts`. Both runtime routing and all model-list consumers use `modelRoutes()` or the same direct-model helper, while the server removes its remaining summary-specific interpretation.

**Tech Stack:** TypeScript, Bun test runner, Zod provider types.

## Global Constraints

- Final client routes are `(models - alias and variant targets) + alias keys + preserve:true targets`.
- Alias default and variant targets use the same `preserve` rule.
- Runtime routing, `/v1/models`, and dashboard `clientModels` must use the same route set.
- Disabled providers remain excluded from runtime routing and `/v1/models`.
- Do not synthesize or mutate provider alias configuration.
- Add no dependencies and do no unrelated refactoring.

---

## File Structure

- `packages/core/src/router.ts`: owns alias routes and directly exposed original model ids.
- `packages/core/_test/router.test.ts`: proves route-set algebra and runtime resolution.
- `packages/server/src/provider-runtime.ts`: derives dashboard summaries from the shared core route set.
- `packages/server/_test/server.test.ts`: proves API/AI SDK listing and disabled-provider summaries.

### Task 1: Share Direct Model Exposure In Core Routing

**Files:**

- Modify: `packages/core/_test/router.test.ts`
- Modify: `packages/core/src/router.ts`
- Modify: `packages/server/_test/server.test.ts`

**Interfaces:**

- Consumes: `ProviderInstance.models`, `ProviderInstance.alias`, and existing `AliasConfig.preserve` values.
- Produces: unchanged public `Router.resolve(model, variantKey?)` and `modelRoutes(provider)` APIs with corrected route contents.

- [ ] **Step 1: Write failing core regression tests**

Update the import in `packages/core/_test/router.test.ts`:

```ts
import { Router, RouterModelCollisionError, RouterModelNotFoundError, modelRoutes } from "../src/index";
```

Replace the test named `does not expose raw model strings unless preserved` with these tests:

```ts
  test("routes a configured model when no alias is present", () => {
    const provider = {
      ...openai,
      alias: undefined,
      models: ["gpt-5-mini"],
    } satisfies ProviderInstance;
    const router = new Router([provider]);

    expect(router.resolve("gpt-5-mini")).toEqual([{ provider, modelId: "gpt-5-mini" }]);
    expect(router.resolve("openai/gpt-5-mini")).toEqual([{ provider, modelId: "gpt-5-mini" }]);
  });

  test("lists aliases, unaliased models, and preserved targets from one shared route set", () => {
    const provider = {
      ...openai,
      models: ["default", "high", "untouched", "preserved"],
      alias: {
        mini: {
          model: "default",
          preserve: false,
          variants: { high: { model: "high", preserve: false } },
        },
        keep: { model: "preserved", preserve: true },
      },
    } satisfies ProviderInstance;

    expect(modelRoutes(provider)).toEqual([
      { alias: "mini", modelId: "default" },
      { alias: "keep", modelId: "preserved" },
      { alias: "untouched", modelId: "untouched" },
      { alias: "preserved", modelId: "preserved" },
    ]);
  });

  test("does not route non-preserved alias and variant targets by original id", () => {
    const provider = {
      ...openai,
      models: ["default", "high"],
      alias: {
        mini: {
          model: "default",
          preserve: false,
          variants: { high: { model: "high", preserve: false } },
        },
      },
    } satisfies ProviderInstance;
    const router = new Router([provider]);

    expect(() => router.resolve("default")).toThrow(RouterModelNotFoundError);
    expect(() => router.resolve("high")).toThrow(RouterModelNotFoundError);
    expect(router.resolve("mini", "high")).toEqual([{ provider, modelId: "high" }]);
  });
```

Also replace `Given api provider with models-only and no alias When OpenAI models are requested Then no models are listed` in `packages/server/_test/server.test.ts` with:

```ts
  test("Given API and AI SDK providers with models only When models are requested Then every model is listed", async () => {
    const app = createServer({
      config: {
        providers: {
          api: {
            kind: "api",
            protocol: ProviderProtocol.OpenAICompatible,
            baseUrl: "https://api.example.com/v1",
            models: ["api-model"],
          },
          sdk: {
            kind: "ai-sdk",
            packageName: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://sdk.example.com/v1", name: "sdk" },
            models: ["sdk-model"],
          },
        },
      },
    });

    const response = await app.request("/v1/models");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: "list",
      data: [
        { id: "api-model", object: "model", owned_by: "api" },
        { id: "sdk-model", object: "model", owned_by: "sdk" },
      ],
    });
  });
```

- [ ] **Step 2: Run the focused core tests and verify RED**

Run:

```bash
rtk bun test packages/core/_test/router.test.ts
rtk bun test packages/server/_test/server.test.ts --test-name-pattern "models only"
```

Expected: both commands FAIL because the router and `/v1/models` omit models-only providers, while `modelRoutes()` also omits `untouched`.

- [ ] **Step 3: Implement the shared direct-model helper**

In `packages/core/src/router.ts`, replace both loops over `preservedModelIds(provider)` with loops over `directModelIds(provider)`:

```ts
      for (const modelId of directModelIds(provider)) {
        this.addRoute(provider, modelId, { model: modelId, preserve: false });
      }
```

```ts
  for (const modelId of directModelIds(provider)) {
    if (!routes.some((route) => route.alias === modelId && route.modelId === modelId)) {
      routes.push({ alias: modelId, modelId });
    }
  }
```

Add this helper immediately before `preservedModelIds()`:

```ts
function directModelIds(provider: ProviderInstance): string[] {
  const modelIds = new Set<string>("models" in provider ? (provider.models ?? []) : []);
  for (const config of Object.values(provider.alias ?? {})) {
    modelIds.delete(config.model);
    for (const target of Object.values(config.variants ?? {})) {
      modelIds.delete(target.model);
    }
  }
  for (const modelId of preservedModelIds(provider)) {
    modelIds.add(modelId);
  }
  return [...modelIds];
}
```

Do not change `addRoute()`, `preservedModelIds()`, or variant resolution.

- [ ] **Step 4: Run the focused core tests and verify GREEN**

Run:

```bash
rtk bun test packages/core/_test/router.test.ts
rtk bun test packages/server/_test/server.test.ts --test-name-pattern "models only"
```

Expected: both commands PASS.

- [ ] **Step 5: Run the complete core unit suite**

Run:

```bash
rtk bun run --filter @aio-proxy/core test:unit
```

Expected: PASS with zero failures.

- [ ] **Step 6: Commit the core fix**

Run:

```bash
rtk git add packages/core/src/router.ts packages/core/_test/router.test.ts packages/server/_test/server.test.ts
rtk git commit -m "fix(core): expose unaliased provider models" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Align Server Listing And Dashboard Summaries

**Files:**

- Modify: `packages/server/_test/server.test.ts`
- Modify: `packages/server/src/provider-runtime.ts`

**Interfaces:**

- Consumes: corrected `modelRoutes(provider)` from Task 1.
- Produces: `/v1/models` entries and `DashboardProviderSummary.clientModels` with identical client-facing ids.

- [ ] **Step 1: Write failing server regression tests**

Extend the disabled-provider test configuration so the provider has a replaced model and an untouched model:

```ts
            models: ["gpt-disabled", "gpt-untouched"],
            alias: { disabled: { model: "gpt-disabled", preserve: false } },
```

Keep the `/v1/models` expectation empty and change its dashboard summary expectation to:

```ts
          clientModels: ["disabled", "gpt-untouched"],
```

- [ ] **Step 2: Run focused server tests and verify RED**

Run:

```bash
rtk bun test packages/server/_test/server.test.ts --test-name-pattern "models|disabled provider"
```

Expected: the models-only listing passes through Task 1, while the disabled-provider dashboard assertion FAILS because `providerConfigSummary()` drops the untouched model whenever `alias` exists.

- [ ] **Step 3: Reuse `modelRoutes()` for disabled-provider summaries**

In `packages/server/src/provider-runtime.ts`, replace `providerConfigSummary()` with:

```ts
function providerConfigSummary(provider: Provider): DashboardProviderSummary {
  const clientModels = [...new Set(modelRoutes(provider).map((route) => route.alias))];
  return {
    id: provider.id,
    kind: provider.kind,
    enabled: provider.enabled,
    passthrough: provider.kind === ProviderKind.Api,
    last_status: "unknown",
    last_latency: null,
    name: provider.name,
    clientModels,
    hasApiKey: provider.kind === ProviderKind.Api ? provider.apiKey !== undefined : undefined,
  };
}
```

- [ ] **Step 4: Run focused server tests and verify GREEN**

Run:

```bash
rtk bun test packages/server/_test/server.test.ts --test-name-pattern "models|disabled provider"
```

Expected: PASS with all matching tests green.

- [ ] **Step 5: Run the complete server unit suite**

Run:

```bash
rtk bun run --filter @aio-proxy/server test:unit
```

Expected: PASS with zero failures.

- [ ] **Step 6: Run repository checks**

Run:

```bash
rtk bun run check
rtk bun run build
```

Expected: both commands exit 0 with no diagnostics caused by the change.

- [ ] **Step 7: Commit the server alignment**

Run:

```bash
rtk git add packages/server/src/provider-runtime.ts packages/server/_test/server.test.ts
rtk git commit -m "fix(server): align model summaries with routing" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Final Regression Verification

**Files:**

- Verify only; no source changes expected.

**Interfaces:**

- Consumes: Tasks 1 and 2 commits.
- Produces: fresh evidence that the requested behavior and repository checks pass together.

- [ ] **Step 1: Run focused regression tests together**

Run:

```bash
rtk bun test packages/core/_test/router.test.ts packages/server/_test/server.test.ts
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run the repository unit suite**

Run:

```bash
rtk bun run test:unit
```

Expected: PASS with zero failures.

- [ ] **Step 3: Confirm the worktree contains only intended changes**

Run:

```bash
rtk git status --short
rtk git log -4 --oneline
```

Expected: no uncommitted source changes; the recent history contains the design, implementation plan, core fix, and server alignment commits.
