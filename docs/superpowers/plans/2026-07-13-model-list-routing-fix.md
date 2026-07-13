# Model List And Routing Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose models-only providers, hide non-preserved upstream targets for added aliases, and keep targets visible when an alias overrides a configured model id.

**Architecture:** Keep the complete exposure rule in `packages/core/src/router.ts`. `directModelIds()` will distinguish an added alias from an override by checking whether the alias key belongs to the provider's original `models` set; both runtime routing and model-list consumers continue to share that helper.

**Tech Stack:** TypeScript, Bun test runner, Zod-normalized provider configuration.

## Global Constraints

- With no aliases, every API or AI SDK `models` entry is directly routable and listed.
- An alias key absent from `models` hides each non-preserved default or variant target under its upstream id.
- An alias key present in `models` overrides that model's self-route without hiding its targets.
- `preserve: true` keeps a target directly exposed.
- Alias keys always win over same-named self-routes.
- OAuth derived-alias behavior remains unchanged.
- Runtime routing, `/v1/models`, and dashboard `clientModels` use the same route set.
- Tests and documentation use neutral provider names; do not use real provider nicknames or credentials.
- Add no dependencies and do no unrelated refactoring.

---

## File Structure

- `packages/core/_test/router.test.ts`: proves models-only, added-alias, override-alias, variant, and preserve behavior.
- `packages/core/src/router.ts`: owns the shared direct-model exposure calculation.
- `packages/server/_test/server.test.ts`: proves `/v1/models` exposes only client-facing ids for an Anthropic API provider with added aliases.
- `docs/superpowers/specs/2026-07-13-model-list-routing-fix-design.md`: records the approved rename-versus-override rule.

### Task 1: Correct Core Exposure Algebra

**Files:**

- Modify: `packages/core/_test/router.test.ts`
- Modify: `packages/core/src/router.ts`
- Modify: `packages/server/_test/server.test.ts`

**Interfaces:**

- Consumes: `ProviderInstance.models`, `ProviderInstance.alias`, `AliasConfig.preserve`, and variant target `preserve` values.
- Produces: unchanged `Router.resolve(model, variantKey?)` and `modelRoutes(provider)` APIs with corrected route contents, plus `/v1/models` regression coverage.

- [ ] **Step 1: Write the failing added-alias regression test**

Replace the current tests named `lists aliases and every configured model from one shared route set` and `keeps configured alias and variant targets routable by original id` in `packages/core/_test/router.test.ts` with:

```ts
  test("hides non-preserved targets for added aliases", () => {
    const provider = {
      ...openai,
      id: "anthropic-aliases",
      models: ["upstream-opus-48", "upstream-opus-46", "upstream-sonnet-46", "untouched"],
      alias: {
        "claude-opus-4-8": { model: "upstream-opus-48", preserve: false },
        "claude-opus-4-6": { model: "upstream-opus-46", preserve: false },
        "claude-sonnet-4-6": {
          model: "upstream-sonnet-46",
          preserve: false,
          variants: { fast: { model: "upstream-opus-46", preserve: false } },
        },
      },
    } satisfies ProviderInstance;
    const router = new Router([provider]);

    expect(modelRoutes(provider)).toEqual([
      { alias: "claude-opus-4-8", modelId: "upstream-opus-48" },
      { alias: "claude-opus-4-6", modelId: "upstream-opus-46" },
      { alias: "claude-sonnet-4-6", modelId: "upstream-sonnet-46" },
      { alias: "untouched", modelId: "untouched" },
    ]);
    expect(router.resolve("claude-opus-4-8")).toEqual([{ provider, modelId: "upstream-opus-48" }]);
    expect(router.resolve("claude-sonnet-4-6", "fast")).toEqual([{ provider, modelId: "upstream-opus-46" }]);
    expect(() => router.resolve("upstream-opus-48")).toThrow(RouterModelNotFoundError);
    expect(() => router.resolve("upstream-opus-46")).toThrow(RouterModelNotFoundError);
    expect(() => router.resolve("upstream-sonnet-46")).toThrow(RouterModelNotFoundError);
    expect(router.resolve("untouched")).toEqual([{ provider, modelId: "untouched" }]);
  });
```

Keep the existing `routes a configured model when no alias is present` and `lets an alias shadow a same-named configured model while keeping its target routable` tests unchanged. Together they prove the no-alias and override branches.

Add this test after the models-only provider test in `packages/server/_test/server.test.ts`:

```ts
  test("Given added Anthropic aliases When models are requested Then upstream targets are hidden", async () => {
    const app = createServer({
      config: {
        providers: {
          "anthropic-aliases": {
            kind: "api",
            protocol: ProviderProtocol.Anthropic,
            baseUrl: "https://anthropic.example.com",
            models: ["upstream-opus-48", "upstream-opus-46", "upstream-sonnet-46"],
            alias: {
              "claude-opus-4-8": "upstream-opus-48",
              "claude-opus-4-6": "upstream-opus-46",
              "claude-sonnet-4-6": "upstream-sonnet-46",
            },
          },
        },
      },
    });

    const response = await app.request("/v1/models");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: "list",
      data: [
        { id: "claude-opus-4-8", object: "model", owned_by: "anthropic-aliases" },
        { id: "claude-opus-4-6", object: "model", owned_by: "anthropic-aliases" },
        { id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic-aliases" },
      ],
    });
  });
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
rtk bun test packages/core/_test/router.test.ts --test-name-pattern "hides non-preserved targets for added aliases"
rtk bun test packages/server/_test/server.test.ts --test-name-pattern "added Anthropic aliases"
```

Expected: both commands FAIL because core routing and `/v1/models` include the three upstream target ids.

- [ ] **Step 3: Implement the minimal conditional hiding rule**

Replace `directModelIds()` in `packages/core/src/router.ts` with:

```ts
function directModelIds(provider: ProviderInstance): string[] {
  const configuredModelIds = new Set<string>(
    provider.kind === ProviderKind.OAuth || !("models" in provider) ? [] : (provider.models ?? []),
  );
  const modelIds = new Set(configuredModelIds);

  for (const [alias, config] of Object.entries(provider.alias ?? {})) {
    modelIds.delete(alias);
    if (configuredModelIds.has(alias)) {
      continue;
    }
    if (!config.preserve) {
      modelIds.delete(config.model);
    }
    for (const target of Object.values(config.variants ?? {})) {
      if (!target.preserve) {
        modelIds.delete(target.model);
      }
    }
  }

  for (const modelId of preservedModelIds(provider)) {
    modelIds.add(modelId);
  }
  return [...modelIds];
}
```

Do not change `addRoute()`, `preservedModelIds()`, alias normalization, or variant resolution.

- [ ] **Step 4: Run focused core tests and verify GREEN**

Run:

```bash
rtk bun test packages/core/_test/router.test.ts --test-name-pattern "configured model when no alias|hides non-preserved targets|same-named configured model"
rtk bun test packages/server/_test/server.test.ts --test-name-pattern "models only|added Anthropic aliases|configured providers"
```

Expected: all matching tests pass with zero failures. The models-only case still lists configured ids, the added-alias case lists only aliases, and the override case keeps both ids.

- [ ] **Step 5: Run the complete core router test file**

Run:

```bash
rtk bun test packages/core/_test/router.test.ts packages/server/_test/server.test.ts
```

Expected: all tests pass with zero failures.

### Task 2: Verify And Publish The Correction

**Files:**

- Verify: `packages/core/src/router.ts`
- Verify: `packages/core/_test/router.test.ts`
- Verify: `packages/server/_test/server.test.ts`

**Interfaces:**

- Consumes: corrected core routing and server regression tests from Task 1.
- Produces: fresh repository-wide verification and an updated PR branch.

- [ ] **Step 1: Run full verification**

Run:

```bash
rtk bun test packages/core/_test/router.test.ts packages/server/_test/server.test.ts
rtk bun run test:unit
rtk bun run check
rtk bun run build
rtk git diff --check
```

Expected: every command exits 0; tests report zero failures; `check` has no new diagnostics; the diff has no whitespace errors.

- [ ] **Step 2: Commit and push the correction**

Run:

```bash
rtk git add packages/core/src/router.ts packages/core/_test/router.test.ts packages/server/_test/server.test.ts docs/superpowers/specs/2026-07-13-model-list-routing-fix-design.md docs/superpowers/plans/2026-07-13-model-list-routing-fix.md
rtk git commit -m "fix(core): distinguish alias renames from overrides" -m "Co-authored-by: Codex <noreply@openai.com>"
rtk git push
```

Expected: the branch push succeeds and PR #24 updates to the new commit.
