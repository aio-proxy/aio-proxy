# Model Alias Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split provider `models` from client-facing `alias` routing, with `preserve` and reusable variant target config.

**Architecture:** Keep config parsing in `@aio-proxy/types`, route construction in `Router`, and provider materialization as pass-through data plumbing. `models` becomes upstream-only `string[]`; `alias` becomes the only source of client-facing model ids.

**Tech Stack:** TypeScript, Bun test, Zod 4. Context7 docs for `/colinhacks/zod` confirm `z.record(z.string(), Schema)`, `z.union`, `.transform()`, and `.superRefine()` are the right tools.

---

## File Structure

- Modify `packages/types/src/common.ts`: replace `ModelEntrySchema` with model id and alias config schemas.
- Modify `packages/types/src/provider.ts`: change provider schemas to `models?: string[]` and `alias?: Record<string, string | AliasConfig>`.
- Modify `packages/types/_test/schemas.test.ts`: cover alias parsing, shorthand normalization, preserve, variants, and invalid targets.
- Modify `packages/core/src/index.ts`: build router routes from `provider.alias`, not mixed model entries.
- Modify `packages/core/_test/router.test.ts`: cover alias-only exposure and `preserve`.
- Modify `packages/core/src/provider/api.ts`, `packages/core/src/provider/ai-sdk.ts`, `packages/core/src/provider/api-bridge.ts`, `packages/server/src/runtime.ts`: type/data plumbing for `alias`.
- Modify `packages/server/src/server.ts`: list exposed models from aliases and preserved originals.
- Modify `packages/server/_test/server.test.ts`: assert `/v1/models` ignores raw models and returns aliases.
- Modify `packages/server/src/oauth-runtime.ts` and `packages/server/_test/oauth-provider-runtime.test.ts`: read Copilot transport metadata from OAuth auth payload while exposing new config shape.
- Modify `packages/cli/src/provider-commands.ts` and `packages/cli/_test/provider-commands.test.ts`: OAuth login writes `models: string[]` and self-alias entries.

---

### Task 1: Types Schema

**Files:**
- Modify: `packages/types/src/common.ts`
- Modify: `packages/types/src/provider.ts`
- Test: `packages/types/_test/schemas.test.ts`

- [ ] **Step 1: Write failing schema tests**

Add these tests inside `describe("ConfigSchema", ...)` in `packages/types/_test/schemas.test.ts`:

```ts
  test("accepts provider alias config and normalizes variant shorthand", () => {
    const provider = {
      ...apiProvider,
      models: ["gemini-3.5-flash", "gemini-3.5-flash-medium", "gemini-3.5-flash-low"],
      alias: {
        "gemini-3-flash-agent": {
          model: "gemini-3.5-flash",
          preserve: true,
          variants: {
            medium: { model: "gemini-3.5-flash-medium", preserve: true },
            low: "gemini-3.5-flash-low",
          },
        },
        "gemini-3.5-flash": "gemini-3.5-flash",
      },
    };

    expect(ConfigSchema.parse(providers({ gemini: provider })).providers[0]).toEqual({
      ...provider,
      enabled: true,
      id: "gemini",
      alias: {
        "gemini-3-flash-agent": {
          model: "gemini-3.5-flash",
          preserve: true,
          variants: {
            medium: { model: "gemini-3.5-flash-medium", preserve: true },
            low: { model: "gemini-3.5-flash-low", preserve: false },
          },
        },
        "gemini-3.5-flash": { model: "gemini-3.5-flash", preserve: false },
      },
    });
  });

  test("rejects object model entries now that aliases are separate", () => {
    expectIssuePath(
      {
        server: {},
        providers: {
          openai: {
            ...apiProvider,
            models: [{ alias: "mini", id: "gpt-5-mini" }],
          },
        },
      },
      ["providers", "openai", "models", 0],
    );
  });

  test("rejects alias target outside configured models", () => {
    expectIssuePath(
      {
        server: {},
        providers: {
          openai: {
            ...apiProvider,
            models: ["gpt-5-mini"],
            alias: { mini: { model: "missing-model" } },
          },
        },
      },
      ["providers", "openai", "alias", "mini", "model"],
    );
  });

  test("rejects variant target outside configured models", () => {
    expectIssuePath(
      {
        server: {},
        providers: {
          openai: {
            ...apiProvider,
            models: ["gpt-5-mini"],
            alias: {
              mini: {
                model: "gpt-5-mini",
                variants: { low: "missing-model" },
              },
            },
          },
        },
      },
      ["providers", "openai", "alias", "mini", "variants", "low", "model"],
    );
  });
```

- [ ] **Step 2: Run the schema test and verify it fails**

Run:

```bash
rtk bun test packages/types/_test/schemas.test.ts
```

Expected: FAIL because `alias` is not in provider schemas and object model entries are still accepted.

- [ ] **Step 3: Implement the minimal schema**

Replace `packages/types/src/common.ts` with:

```ts
import { z } from "zod";

export const IdSchema = z.string().min(1);
export const ModelIdSchema = IdSchema.describe("Upstream model id exposed by a provider.");

const AliasTargetObjectSchema = z.object({
  model: ModelIdSchema.describe("Default upstream model id for this alias target."),
  preserve: z.boolean().default(false).describe("Expose the target model under its original id as well."),
});

export const AliasTargetSchema = z
  .union([ModelIdSchema, AliasTargetObjectSchema])
  .transform((value) => (typeof value === "string" ? { model: value, preserve: false } : value));

export const AliasConfigSchema = z
  .union([
    ModelIdSchema,
    AliasTargetObjectSchema.extend({
      variants: z.record(z.string().min(1), AliasTargetSchema).optional(),
    }),
  ])
  .transform((value) => (typeof value === "string" ? { model: value, preserve: false } : value));

export type ModelIdInput = z.input<typeof ModelIdSchema>;
export type ModelId = z.output<typeof ModelIdSchema>;
export type AliasTargetInput = z.input<typeof AliasTargetSchema>;
export type AliasTarget = z.output<typeof AliasTargetSchema>;
export type AliasConfigInput = z.input<typeof AliasConfigSchema>;
export type AliasConfig = z.output<typeof AliasConfigSchema>;
```

In `packages/types/src/provider.ts`, replace the `ModelEntrySchema` import with:

```ts
import { AliasConfigSchema, ModelIdSchema } from "./common";
```

Add a shared provider field object:

```ts
const ProviderModelsSchema = {
  models: z.array(ModelIdSchema).optional().describe("Upstream model ids available through this provider."),
  alias: z.record(z.string().min(1), AliasConfigSchema).optional().describe("Client-facing model aliases."),
} as const;
```

Spread `...ProviderModelsSchema` into `ApiProviderSchema`, `OAuthProviderSchema`, and `AiSdkProviderSchema` in place of each current `models: z.array(ModelEntrySchema)...` line.

Add this helper and apply `.superRefine(validateAliasTargets)` to the `ProviderSchema` discriminated union. Keep `ApiProviderSchema`, `OAuthProviderSchema`, and `AiSdkProviderSchema` as plain objects so `config.ts` can still call `.omit({ id: true })` on them:

```ts
function validateAliasTargets(
  provider: { readonly models?: readonly string[]; readonly alias?: Record<string, { readonly model: string; readonly variants?: Record<string, { readonly model: string }> }> },
  ctx: z.RefinementCtx,
): void {
  if (provider.models === undefined || provider.alias === undefined) {
    return;
  }
  const models = new Set(provider.models);
  for (const [alias, config] of Object.entries(provider.alias)) {
    if (!models.has(config.model)) {
      ctx.addIssue({
        code: "custom",
        message: `Alias target "${config.model}" is not listed in models`,
        path: ["alias", alias, "model"],
      });
    }
    for (const [variant, target] of Object.entries(config.variants ?? {})) {
      if (!models.has(target.model)) {
        ctx.addIssue({
          code: "custom",
          message: `Alias variant target "${target.model}" is not listed in models`,
          path: ["alias", alias, "variants", variant, "model"],
        });
      }
    }
  }
}
```

- [ ] **Step 4: Run the schema test and verify it passes**

Run:

```bash
rtk bun test packages/types/_test/schemas.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
rtk git add packages/types/src/common.ts packages/types/src/provider.ts packages/types/_test/schemas.test.ts
rtk git commit -m "feat(types): split model aliases from model ids" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Router Alias Resolution

**Files:**
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/_test/router.test.ts`

- [ ] **Step 1: Write failing router tests**

Update the provider fixtures in `packages/core/_test/router.test.ts` to use `alias`:

```ts
const copilot = {
  kind: "oauth",
  id: "copilot",
  vendor: "github-copilot",
  models: ["claude-sonnet-4-5"],
  alias: { sonnet: { model: "claude-sonnet-4-5", preserve: false } },
} satisfies ProviderInstance;

const openai = {
  kind: "api",
  id: "openai",
  protocol: ProviderProtocol.OpenAIResponse,
  models: ["gpt-5-mini"],
  alias: {
    mini: { model: "gpt-5-mini", preserve: true },
  },
} satisfies ProviderInstance;
```

Replace the direct-model test with:

```ts
  test("does not expose raw model strings unless preserved", () => {
    const router = new Router([{ ...openai, alias: { mini: { model: "gpt-5-mini", preserve: false } } }]);

    expect(() => router.resolve("gpt-5-mini")).toThrow(RouterModelNotFoundError);
  });
```

Keep the fully qualified direct model test, but it should pass because `openai.alias.mini.preserve` is true:

```ts
  test("resolves a fully-qualified preserved original model id", () => {
    const router = new Router([openai]);

    const resolved = router.resolve("openai/gpt-5-mini");

    expect(resolved).toEqual([{ provider: openai, modelId: "gpt-5-mini" }]);
  });
```

Update duplicate tests to duplicate through `alias`:

```ts
  test("rejects duplicate provider-specific aliases from preserve collisions", () => {
    const duplicate = {
      kind: "api",
      id: "dupe",
      protocol: ProviderProtocol.OpenAIResponse,
      models: ["first", "second"],
      alias: {
        firstAlias: { model: "first", preserve: true },
        secondAlias: { model: "first", preserve: true },
      },
    } satisfies ProviderInstance;

    expect(() => new Router([duplicate])).toThrow(/dupe/);
  });
```

- [ ] **Step 2: Run router tests and verify they fail**

Run:

```bash
rtk bun test packages/core/_test/router.test.ts
```

Expected: FAIL because `Router` still reads mixed `provider.models`.

- [ ] **Step 3: Implement route generation from alias**

In `packages/core/src/index.ts`, change the import:

```ts
import type { Provider as ConfigProvider, ProviderProtocol } from "@aio-proxy/types";
```

Replace the constructor loop and delete `modelRoute`:

```ts
  constructor(providers: readonly TProvider[]) {
    for (const provider of providers) {
      if (provider.enabled === false) {
        continue;
      }
      for (const model of modelRoutes(provider)) {
        this.addRoute(provider, model);
      }
    }
  }
```

Add:

```ts
function modelRoutes(provider: ProviderInstance): ModelRoute[] {
  return Object.entries(provider.alias ?? {}).flatMap(([alias, config]) => [
    { alias, modelId: config.model },
    ...(config.preserve ? [{ alias: config.model, modelId: config.model }] : []),
  ]);
}
```

- [ ] **Step 4: Run router tests and verify they pass**

Run:

```bash
rtk bun test packages/core/_test/router.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
rtk git add packages/core/src/index.ts packages/core/_test/router.test.ts
rtk git commit -m "feat(core): route through alias config" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Provider Plumbing And Model Listing

**Files:**
- Modify: `packages/core/src/provider/api.ts`
- Modify: `packages/core/src/provider/ai-sdk.ts`
- Modify: `packages/core/src/provider/api-bridge.ts`
- Modify: `packages/server/src/runtime.ts`
- Modify: `packages/server/src/server.ts`
- Test: `packages/server/_test/server.test.ts`

- [ ] **Step 1: Write failing `/v1/models` test**

In `packages/server/_test/server.test.ts`, change the top-level `config` providers to include aliases:

```ts
      models: ["gpt-test"],
      alias: {
        "gpt-alias": { model: "gpt-test", preserve: true },
      },
```

```ts
      models: ["compatible-test"],
      alias: {
        compatible: { model: "compatible-test", preserve: false },
      },
```

Update the model list expectation:

```ts
      data: [
        { id: "gpt-alias", object: "model", owned_by: "openai-compatible" },
        { id: "gpt-test", object: "model", owned_by: "openai-compatible" },
        { id: "compatible", object: "model", owned_by: "compatible" },
      ],
```

Add an assertion in the disabled provider test that raw `models` alone does not expose anything:

```ts
    expect(await models.json()).toEqual({ object: "list", data: [] });
```

- [ ] **Step 2: Run server model tests and verify they fail**

Run:

```bash
rtk bun test packages/server/_test/server.test.ts --test-name-pattern "models"
```

Expected: FAIL because `/v1/models` still reads `provider.models`.

- [ ] **Step 3: Thread `alias` through provider instances**

In `packages/core/src/provider/api.ts`, add `alias` to `createApiProvider` return:

```ts
    ...(config.alias === undefined ? {} : { alias: config.alias }),
```

In `packages/core/src/provider/ai-sdk.ts`, update the type and return object:

```ts
import type { AiSdkProvider, AliasConfig, ModelId, ProviderKind } from "@aio-proxy/types";
```

```ts
  readonly models?: readonly ModelId[];
  readonly alias?: Readonly<Record<string, AliasConfig>>;
```

```ts
    ...(config.alias === undefined ? {} : { alias: config.alias }),
```

In `packages/core/src/provider/api-bridge.ts`, add alias to the synthesized config:

```ts
    ...(provider.alias === undefined ? {} : { alias: provider.alias }),
```

In `packages/server/src/runtime.ts`, update imports and OAuth provider type:

```ts
import type { AliasConfig, ModelId, ProviderKind } from "@aio-proxy/types";
```

```ts
  readonly models?: ModelId[];
  readonly alias?: Readonly<Record<string, AliasConfig>>;
```

- [ ] **Step 4: Update `/v1/models` listing**

In `packages/server/src/server.ts`, replace the current `.flatMap((provider) => (provider.models ?? []).map(...))` block with:

```ts
        .flatMap((provider) =>
          exposedModels(provider.alias).map((model) => ({
            id: model,
            object: "model",
            owned_by: provider.id,
          })),
        ),
```

Add this helper near `createRoutes`:

```ts
function exposedModels(alias: RuntimeProviderInstance["alias"]): string[] {
  const ids: string[] = [];
  for (const [clientModel, config] of Object.entries(alias ?? {})) {
    ids.push(clientModel);
    if (config.preserve) {
      ids.push(config.model);
    }
  }
  return ids;
}
```

- [ ] **Step 5: Run server tests and verify they pass**

Run:

```bash
rtk bun test packages/server/_test/server.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
rtk git add packages/core/src/provider/api.ts packages/core/src/provider/ai-sdk.ts packages/core/src/provider/api-bridge.ts packages/server/src/runtime.ts packages/server/src/server.ts packages/server/_test/server.test.ts
rtk git commit -m "feat(server): list exposed aliases" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: OAuth And CLI Model Sync

**Files:**
- Modify: `packages/server/src/oauth-runtime.ts`
- Modify: `packages/server/_test/oauth-provider-runtime.test.ts`
- Modify: `packages/cli/src/provider-commands.ts`
- Modify: `packages/cli/_test/provider-commands.test.ts`

- [ ] **Step 1: Write failing OAuth runtime test**

In `packages/server/_test/oauth-provider-runtime.test.ts`, change parsed config models to the new shape:

```ts
    Auth.set("github-copilot", "copilot-12345", {
      access: "copilot-token",
      refresh: "github-token",
      expires: Date.now() + 60_000,
      baseUrl: "https://api.individual.githubcopilot.com",
      models: [
        { alias: "gpt-5-mini", id: "gpt-5-mini", transport: "chat" },
        { alias: "claude-sonnet-4", id: "claude-sonnet-4", transport: "messages" },
        { alias: "gpt-5", id: "gpt-5", transport: "responses" },
      ],
    });
```

```ts
            models: ["gpt-5-mini", "claude-sonnet-4", "gpt-5"],
            alias: {
              "gpt-5-mini": { model: "gpt-5-mini", preserve: false },
              "claude-sonnet-4": { model: "claude-sonnet-4", preserve: false },
              "gpt-5": { model: "gpt-5", preserve: false },
            },
```

Update the provider expectation:

```ts
      models: ["gpt-5-mini", "claude-sonnet-4", "gpt-5"],
      alias: {
        "gpt-5-mini": { model: "gpt-5-mini", preserve: false },
        "claude-sonnet-4": { model: "claude-sonnet-4", preserve: false },
        "gpt-5": { model: "gpt-5", preserve: false },
      },
```

- [ ] **Step 2: Write failing CLI sync test**

In `packages/cli/_test/provider-commands.test.ts`, update fake login model expectations so the written config is:

```ts
models: ["gpt-5-mini"],
alias: {
  "gpt-5-mini": { model: "gpt-5-mini", preserve: false },
},
```

- [ ] **Step 3: Run OAuth and CLI tests and verify they fail**

Run:

```bash
rtk bun test packages/server/_test/oauth-provider-runtime.test.ts packages/cli/_test/provider-commands.test.ts
```

Expected: FAIL because OAuth runtime and CLI still expect model objects.

- [ ] **Step 4: Update OAuth runtime**

In `packages/server/src/oauth-runtime.ts`, read cached Copilot metadata from auth payload instead of public config:

```ts
  } | null;
  const cachedModels = cachedCopilotModels(payload?.models);
  const transportByModelId = new Map(cachedModels?.map(({ id, transport }) => [id, transport]) ?? []);
```

Add alias to the returned provider:

```ts
    ...(config.alias === undefined ? {} : { alias: config.alias }),
```

Keep `CachedCopilotModel` and `cachedCopilotModels`, but change their input source from `config.models` to `payload.models`.

- [ ] **Step 5: Update CLI login config write**

In `packages/cli/src/provider-commands.ts`, add a helper for public config:

```ts
function modelConfig(models: readonly OAuthProviderModel[] | undefined) {
  if (models === undefined) {
    return {};
  }
  return {
    models: models.map((model) => model.id),
    alias: Object.fromEntries(models.map((model) => [model.alias, { model: model.id, preserve: false }])),
  };
}
```

After `const models = await githubCopilotOAuthProvider.models(result.payload);`, persist the internal model metadata to auth storage:

```ts
  Auth.set("github-copilot", result.providerId, { ...result.payload, models }, result.providerId);
```

Use it in `providerLogin`:

```ts
  providers[result.providerId] = {
    kind: "oauth",
    vendor: "github-copilot",
    ...modelConfig(result.models),
  };
```

- [ ] **Step 6: Run OAuth and CLI tests and verify they pass**

Run:

```bash
rtk bun test packages/server/_test/oauth-provider-runtime.test.ts packages/cli/_test/provider-commands.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
rtk git add packages/server/src/oauth-runtime.ts packages/server/_test/oauth-provider-runtime.test.ts packages/cli/src/provider-commands.ts packages/cli/_test/provider-commands.test.ts
rtk git commit -m "feat(oauth): sync models with alias config" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Sweep Old ModelEntry Usage And Verify

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/provider/ai-sdk.ts`
- Modify: `packages/server/src/runtime.ts`
- Modify: `packages/types/src/common.ts`
- Modify: `packages/types/src/provider.ts`
- Test: `packages/core/_test/router.test.ts`
- Test: `packages/core/_test/provider/ai-sdk.test.ts`
- Test: `packages/cli/_test/provider-commands.test.ts`

- [ ] **Step 1: Find old mixed model entries**

Run:

```bash
rtk rg -n "ModelEntry|models: \\[\\{" packages
```

Expected: no source import of `ModelEntry` remains. Remaining `models: [{` hits are active fixtures that need conversion in the next step.

- [ ] **Step 2: Update remaining tests to new config shape**

For each active test fixture that uses:

```ts
models: [{ alias: "alias-model", id: "routed-model" }]
```

replace it with:

```ts
models: ["routed-model"],
alias: { "alias-model": { model: "routed-model", preserve: false } }
```

For each active test fixture that relies on direct string exposure:

```ts
models: ["gpt-test"]
```

replace it with:

```ts
models: ["gpt-test"],
alias: { "gpt-test": { model: "gpt-test", preserve: false } }
```

- [ ] **Step 3: Run the focused package tests**

Run:

```bash
rtk bun test packages/types/_test packages/core/_test packages/server/_test packages/cli/_test
```

Expected: PASS.

- [ ] **Step 4: Run repo checks**

Run:

```bash
rtk bun run check
rtk bun run test:unit
```

Expected: both PASS.

- [ ] **Step 5: Commit**

Run:

```bash
rtk git add packages
rtk git commit -m "test: update model alias fixtures" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Self-Review

Spec coverage:
- `models` as `string[]`: Task 1.
- `alias` with string shorthand, `model`, `preserve`, and reusable `variants`: Task 1.
- Router uses alias keys and preserved originals only: Task 2.
- `/v1/models` lists exposed aliases: Task 3.
- OAuth and CLI write new config shape: Task 4.
- Old mixed `ModelEntry` cleanup: Task 5.

Placeholder scan:
- No placeholder steps; each task has exact files, snippets, commands, and expected outcomes.

Type consistency:
- Public config output uses `ModelId[]` and `Record<string, AliasConfig>`.
- Router and server consume normalized alias output, so string shorthand stays inside schema parsing.
