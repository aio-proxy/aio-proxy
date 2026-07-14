# Provider Base URL Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the unreleased API provider endpoint field from `baseUrl` to `baseURL` end to end and default missing OpenAI-compatible AI SDK provider names to the Provider ID.

**Architecture:** Keep one canonical `baseURL` field across configuration, parsed types, runtime providers, raw dispatch, bridge dispatch, dashboard forms, and persisted mutations. Add the OpenAI-compatible `name` default at the existing `createAiSdkProvider` materialization seam, where package name and Provider ID are both available, while leaving the generic loader and OAuth payloads unchanged.

**Tech Stack:** TypeScript 6, Bun 1.3.14, Zod 4, Hono, React/TanStack Form, Rslib, Rstest.

## Global Constraints

- `ProviderKind.Api` accepts and emits only `baseURL`; do not add a `baseUrl` compatibility alias.
- Keep GitHub Copilot OAuth payload fields named `baseUrl`; they are not API provider configuration.
- For `@ai-sdk/openai-compatible`, default only a missing `options.name`; explicit values remain untouched so invalid non-string values still fail in the loader.
- Do not inject `name` into any other AI SDK package.
- Do not change URL rewriting, credentials, routing order, fallback behavior, or dependencies.
- Preserve all credential values while migrating `.aio-proxy-dev/config.jsonc`; the ignored local file is never staged.
- Preserve and do not stage unrelated workspace changes, including `AGENTS.md` and `docs/agents/` if they are still present at execution time.
- Prefix shell commands with `rtk`; if it is outside the default PATH, use `PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk ...`.

---

## File Structure

- `packages/types/src/provider.ts` owns the canonical API provider configuration and mutation interfaces.
- `packages/types/_test/schemas.test.ts` locks the breaking input shape and validation paths.
- `packages/core/src/provider/api.ts` owns raw API provider runtime dispatch.
- `packages/core/src/provider/api-bridge.ts` adapts API providers to AI SDK model capability.
- `packages/core/src/provider/ai-sdk.ts` materializes direct AI SDK provider load options.
- `packages/core/_test/provider/api.test.ts`, `api-bridge.test.ts`, and `ai-sdk.test.ts` cover those three core modules.
- `packages/server/src/provider-runtime.ts` uses the canonical field for API probes.
- `packages/server/_test/*` fixtures cover reload, routing, capabilities, mutations, and persistence.
- `packages/dashboard/src/modules/providers/components/provider-form-fields-api.tsx` binds the API provider endpoint form field.
- `.aio-proxy-dev/config.jsonc` is the ignored local development configuration used for the final regression request.

### Task 1: Make `baseURL` the Types interface

**Files:**
- Modify: `packages/types/src/provider.ts:43-50,77-88`
- Modify: `packages/types/_test/schemas.test.ts:20-30,248-258,315-575`
- Verify generated artifact: `packages/types/dist/config.schema.json`

**Interfaces:**
- Produces: `ApiProvider.baseURL: string` and `ApiProviderMutationBody.baseURL: string`.
- Produces: configuration and mutation validation errors whose missing-field path ends in `baseURL`.
- Consumes: no implementation output from later tasks.

- [ ] **Step 1: Write the failing schema tests**

Change the shared API provider fixture and the missing-field assertion to the new interface, and add an explicit rejection test for the removed spelling:

```ts
const apiProvider = {
  kind: ProviderKind.Api,
  protocol: ProviderProtocol.OpenAICompatible,
  baseURL: "https://api.example.com",
};

test("rejects api provider without baseURL at providers.openai.baseURL", () => {
  const { baseURL: _baseURL, ...provider } = apiProvider;
  expectIssuePath({ server: {}, providers: { openai: provider } }, ["providers", "openai", "baseURL"]);
});

test("rejects removed api provider baseUrl spelling", () => {
  expectIssuePath(
    {
      server: {},
      providers: {
        openai: {
          kind: ProviderKind.Api,
          protocol: ProviderProtocol.OpenAICompatible,
          baseUrl: "https://api.example.com",
        },
      },
    },
    ["providers", "openai", "baseURL"],
  );
});
```

Update every API provider fixture in this file to use `baseURL`; do not change AI SDK `options.baseURL` fixtures.

- [ ] **Step 2: Run the Types test to verify it fails**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/types/_test/schemas.test.ts
```

Expected: FAIL because `ApiProviderSchema` and `ApiProviderMutationBodySchema` still require `baseUrl`.

- [ ] **Step 3: Rename the canonical schema fields**

In `packages/types/src/provider.ts`, change only the API provider fields:

```ts
export const ApiProviderSchema = z.object({
  kind: z.literal(ProviderKind.Api).describe("Provider backed by a raw HTTP API."),
  ...SharedProviderSchemaBase,
  ...modelsField,
  protocol: ProviderProtocolSchema,
  baseURL: z.url().describe("Provider API base URL."),
  apiKey: z.string().optional().describe("Bearer token or API key for the provider."),
});

export const ApiProviderMutationBodySchema = z.object({
  kind: z.literal(ProviderKind.Api),
  id: z.string().min(1),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  weight: z.number().optional(),
  protocol: ProviderProtocolSchema,
  baseURL: z.url(),
  apiKey: z.string().optional(),
  models: z.array(z.string()).optional(),
  alias: z.record(z.string().min(1), AliasConfigSchema).optional().describe("Client-facing model aliases."),
});
```

- [ ] **Step 4: Run the Types tests and build the JSON Schema**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/types/_test/schemas.test.ts
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/types build
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk proxy bun -e 'const text=await Bun.file("packages/types/dist/config.schema.json").text(); if(!text.includes("\"baseURL\"")||text.includes("\"baseUrl\"")) throw new Error("generated API provider schema is not canonical baseURL"); console.log("config schema uses baseURL only");'
```

Expected: Types tests PASS, build exits 0, and the final command prints `config schema uses baseURL only`.

- [ ] **Step 5: Commit the Types interface change**

```bash
git add packages/types/src/provider.ts packages/types/_test/schemas.test.ts docs/superpowers/specs/2026-07-14-provider-base-url-alignment-design.md docs/superpowers/plans/2026-07-14-provider-base-url-alignment.md
git commit -m "refactor(types): standardize provider baseURL" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Rename the Core API provider runtime field

**Files:**
- Modify: `packages/core/src/provider/api.ts:39-56,102-108`
- Modify: `packages/core/src/provider/api-bridge.ts:20-60`
- Modify: `packages/core/_test/provider/api.test.ts`
- Modify: `packages/core/_test/provider/api-bridge.test.ts`

**Interfaces:**
- Consumes: `ApiProvider.baseURL` from Task 1.
- Produces: `ApiProviderInstance.baseURL` and bridge options `{ baseURL: provider.baseURL }`.
- Preserves: bridge option `name: provider.id` for `ProviderProtocol.OpenAICompatible`.

- [ ] **Step 1: Convert Core tests to the new interface**

In every API provider fixture in `api.test.ts` and `api-bridge.test.ts`, use:

```ts
{
  kind: ProviderKind.Api,
  id: "example",
  protocol: ProviderProtocol.OpenAICompatible,
  baseURL: "https://api.example.com/v1",
}
```

Keep bridge expectations in AI SDK option casing:

```ts
expect(optionsSeen).toMatchObject({
  baseURL: "https://api.example.com/v1",
  name: "example",
});
```

- [ ] **Step 2: Run Core API tests to verify they fail**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/provider/api.test.ts packages/core/_test/provider/api-bridge.test.ts
```

Expected: FAIL because raw dispatch and the bridge still read `provider.baseUrl`.

- [ ] **Step 3: Rename raw runtime use to `baseURL`**

Replace `createApiProvider` with:

```ts
export function createApiProvider(
  config: ApiProviderConfig,
  options: ApiProviderFactoryOptions = {},
): ApiProviderInstance {
  const baseURL = config.baseURL;
  const trace = options.trace ?? config.trace;

  return {
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    baseURL,
    enabled: config.enabled,
    id: config.id,
    kind: config.kind,
    ...(config.models === undefined ? {} : { models: config.models }),
    ...(config.alias === undefined ? {} : { alias: config.alias }),
    protocol: config.protocol,
    async passthrough(req) {
      const upstreamUrl = rewrittenUrl(baseURL, req.url);
      const headers = upstreamHeaders(req.headers, config.protocol, resolveApiKey(config.apiKey));

      const response = await fetch(upstreamUrl, {
        body: req.body,
        headers,
        method: req.method,
        signal: req.signal,
      });

      if (trace === undefined || response.body === null) {
        return new Response(response.body, decodedBodyResponseInit(response));
      }

      const [returnedBody, tracedBody] = response.body.tee();
      void recordTrace(trace, response.status, tracedBody);

      return new Response(returnedBody, decodedBodyResponseInit(response));
    },
  };
}
```

Replace the URL helper with:

```ts
function rewrittenUrl(baseURL: string, requestUrl: string): URL {
  const upstreamUrl = new URL(baseURL);
  const incomingUrl = new URL(requestUrl);
  upstreamUrl.pathname = incomingUrl.pathname;
  upstreamUrl.search = incomingUrl.search;
  return upstreamUrl;
}
```

- [ ] **Step 4: Remove the bridge casing conversion**

Replace `bridgeApiProviderToAiSdk` with:

```ts
export function bridgeApiProviderToAiSdk(
  provider: ApiProvider,
  options: AiSdkProviderFactoryOptions = {},
): AiSdkProviderInstance {
  const baseURL = provider.baseURL;
  const providerId = provider.id;
  const mapping = bridgeMapping(provider, baseURL, providerId);
  const synthesized = {
    kind: ProviderKind.AiSdk,
    enabled: provider.enabled,
    id: `${providerId}:bridge`,
    packageName: mapping.packageName,
    options: mapping.options,
    ...(provider.models === undefined ? {} : { models: provider.models }),
    ...(provider.alias === undefined ? {} : { alias: provider.alias }),
  } satisfies AiSdkProvider;

  return createAiSdkProvider(synthesized, {
    ...options,
    ...(mapping.resolveModel === undefined ? {} : { resolveModel: mapping.resolveModel }),
  });
}
```

Keep `bridgeMapping`'s AI SDK option parameter and output named `baseURL`.

- [ ] **Step 5: Run Core API tests**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/provider/api.test.ts packages/core/_test/provider/api-bridge.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the Core API runtime rename**

```bash
git add packages/core/src/provider/api.ts packages/core/src/provider/api-bridge.ts packages/core/_test/provider/api.test.ts packages/core/_test/provider/api-bridge.test.ts
git commit -m "refactor(core): use canonical provider baseURL" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Default OpenAI-compatible `name` to Provider ID

**Files:**
- Modify: `packages/core/src/provider/ai-sdk.ts:51-60,144-146`
- Modify: `packages/core/_test/provider/ai-sdk.test.ts`

**Interfaces:**
- Consumes: `AiSdkProvider.id`, `AiSdkProvider.packageName`, and `AiSdkProvider.options`.
- Produces: loader options with `name: config.id` only when package is `@ai-sdk/openai-compatible` and `options.name === undefined`.
- Preserves: explicit string or invalid non-undefined `options.name` values for loader validation.

- [ ] **Step 1: Add failing load-option tests**

Add a helper inside the existing `describe("createAiSdkProvider", ...)` block:

```ts
const availableProvider = {
  languageModel() {
    throw new Error("languageModel should not be called by ensureAvailable");
  },
} satisfies Pick<ProviderV3, "languageModel">;
```

Add these tests:

```ts
test("defaults openai-compatible name to the provider id", async () => {
  let optionsSeen: Readonly<Record<string, unknown>> | undefined;
  const provider = createAiSdkProvider(
    {
      kind: "ai-sdk",
      id: "carpool",
      packageName: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://example.test/v1" },
    },
    {
      async loadProvider(_packageName, options) {
        optionsSeen = options;
        return availableProvider;
      },
    },
  );

  await provider.ensureAvailable?.();
  expect(optionsSeen).toEqual({ baseURL: "https://example.test/v1", name: "carpool" });
});

test("preserves an explicit openai-compatible name", async () => {
  let optionsSeen: Readonly<Record<string, unknown>> | undefined;
  const provider = createAiSdkProvider(
    {
      kind: "ai-sdk",
      id: "carpool",
      packageName: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://example.test/v1", name: "custom" },
    },
    {
      async loadProvider(_packageName, options) {
        optionsSeen = options;
        return availableProvider;
      },
    },
  );

  await provider.ensureAvailable?.();
  expect(optionsSeen).toEqual({ baseURL: "https://example.test/v1", name: "custom" });
});

test("does not inject name into other AI SDK packages", async () => {
  let optionsSeen: Readonly<Record<string, unknown>> | undefined;
  const provider = createAiSdkProvider(
    { kind: "ai-sdk", id: "openai", packageName: "@ai-sdk/openai", options: { apiKey: "test" } },
    {
      async loadProvider(_packageName, options) {
        optionsSeen = options;
        return availableProvider;
      },
    },
  );

  await provider.ensureAvailable?.();
  expect(optionsSeen).toEqual({ apiKey: "test" });
});
```

- [ ] **Step 2: Run the AI SDK provider test to verify it fails**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/provider/ai-sdk.test.ts
```

Expected: the default-name test FAILS because the loader currently receives only `{ baseURL }`; the explicit-name and unrelated-package assertions remain useful regression coverage.

- [ ] **Step 3: Implement the package-specific default at materialization**

Replace `loadOptions` with:

```ts
function loadOptions(config: AiSdkProvider): AiSdkProviderLoadOptions {
  const options = config.options ?? {};
  if (config.packageName !== "@ai-sdk/openai-compatible" || options.name !== undefined) {
    return options;
  }
  return { ...options, name: config.id };
}
```

Do not change `loadAiSdkProvider` or weaken its `name`/`baseURL` validation.

- [ ] **Step 4: Run all Core provider tests**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/provider
```

Expected: PASS.

- [ ] **Step 5: Commit the name default**

```bash
git add packages/core/src/provider/ai-sdk.ts packages/core/_test/provider/ai-sdk.test.ts
git commit -m "fix(core): default compatible provider name" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Propagate `baseURL` through Server and Dashboard

**Files:**
- Modify: `packages/server/src/provider-runtime.ts:194-230`
- Modify: `packages/dashboard/src/modules/providers/components/provider-form-fields-api.tsx:21-42`
- Modify: `packages/server/_test/server-reload.test.ts`
- Modify: `packages/server/_test/provider-runtime-capabilities.test.ts`
- Modify: `packages/server/_test/server.test.ts`
- Modify: `packages/server/_test/pipeline-helpers.ts`
- Modify: `packages/server/_test/cross-protocol-routing.test.ts`
- Modify: `packages/server/_test/dashboard-providers-mutation.test.ts`

**Interfaces:**
- Consumes: canonical `ApiProvider.baseURL` and `ApiProviderMutationBody.baseURL` from Task 1.
- Produces: provider probes, dashboard create/edit bodies, and persisted provider records containing only `baseURL`.
- Preserves: `packages/server/src/oauth-runtime.ts`, `packages/server/_test/oauth-provider-runtime.test.ts`, and the OAuth payload fixture at `packages/server/_test/server.test.ts:448` with `baseUrl`.

- [ ] **Step 1: Update Server mutation tests first**

In `dashboard-providers-mutation.test.ts`, change API request fixtures and disk assertions to `baseURL`. Replace the malformed-body assertion with:

```ts
test("POST malformed body missing baseURL returns 400 with zod details", async () => {
  const response = await postProvider({
    kind: "api",
    id: "missing-base-url",
    protocol: "openai-compatible",
  });
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(
    body.details.some((issue: { path: unknown[] }) => Array.isArray(issue.path) && issue.path.includes("baseURL")),
  ).toBe(true);
});

test("POST rejects removed baseUrl spelling", async () => {
  const response = await postProvider({
    kind: "api",
    id: "legacy-spelling",
    protocol: "openai-compatible",
    baseUrl: "https://api.example.com",
  });
  expect(response.status).toBe(400);
});
```

Update the persistence assertion:

```ts
expect(onDisk().providers["seed-api"].baseURL).toBe("https://changed.example.com");
expect(onDisk().providers["seed-api"]).not.toHaveProperty("baseUrl");
```

- [ ] **Step 2: Update API-provider Server fixtures and run tests red**

Rename only API provider configuration/runtime properties to `baseURL` in:

- `server-reload.test.ts`;
- `provider-runtime-capabilities.test.ts` including `Omit<ApiProviderInstance, "baseURL">`, the `Object.defineProperty(..., "baseURL", ...)` guard, and its local read counter;
- `server.test.ts`, except the GitHub Copilot OAuth payload fixture whose `baseUrl` must remain unchanged;
- `pipeline-helpers.ts`;
- `cross-protocol-routing.test.ts`;
- `dashboard-providers-mutation.test.ts`.

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/server/_test/dashboard-providers-mutation.test.ts packages/server/_test/provider-runtime-capabilities.test.ts packages/server/_test/server-reload.test.ts packages/server/_test/cross-protocol-routing.test.ts
```

Expected: FAIL where `provider-runtime.ts` still reads `provider.baseUrl`, or TypeScript/runtime fixtures expose the stale property.

- [ ] **Step 3: Update provider probes to the canonical field**

In `providerProbeRequest`:

```ts
const url = new URL(provider.baseURL);
```

Do not change the protocol switch or any probe request body.

- [ ] **Step 4: Update the Dashboard field binding**

In `provider-form-fields-api.tsx`, bind the canonical mutation property:

```tsx
<div data-testid="provider-form-field-baseURL">
  <form.Field name="baseURL">
    {(field) => (
      <Field>
        <Label htmlFor={field.name}>{m["dashboard.providers.form.label_base_url"]()}</Label>
        <Input
          id={field.name}
          value={field.state.value ?? ""}
          onChange={(event) => field.handleChange(event.target.value)}
          placeholder={m["dashboard.providers.form.placeholder_base_url"]()}
        />
      </Field>
    )}
  </form.Field>
</div>
```

Do not rename translation message keys; they are labels, not provider data fields.

- [ ] **Step 5: Run Server and Dashboard verification**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/server test:unit
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/dashboard test:unit
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/dashboard build
```

Expected: all commands PASS.

- [ ] **Step 6: Verify only intentional `baseUrl` uses remain**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk rg -n '\bbaseUrl\b' packages/types packages/core packages/server packages/dashboard --glob '*.{ts,tsx,json}' --glob '!**/dist/**'
```

Expected remaining matches are limited to:

- `packages/dashboard/src/lib/dashboard-client.ts` local client-origin parameter;
- `packages/server/src/oauth-runtime.ts` OAuth payload parsing;
- OAuth payload fixtures in `packages/server/_test/oauth-provider-runtime.test.ts` and the GitHub Copilot payload fixture in `packages/server/_test/server.test.ts`;
- the removed-spelling rejection test in `packages/types/_test/schemas.test.ts`;
- the removed-spelling rejection test and legacy-property absence assertion in `packages/server/_test/dashboard-providers-mutation.test.ts`.

There must be no remaining accepted API-provider schema, runtime, bridge, dashboard form, or configuration fixture use of `baseUrl`. Negative tests and assertions may mention the exact removed spelling only to prove that it is rejected or absent.

- [ ] **Step 7: Commit Server and Dashboard propagation**

```bash
git add packages/server/src/provider-runtime.ts packages/dashboard/src/modules/providers/components/provider-form-fields-api.tsx packages/server/_test/server-reload.test.ts packages/server/_test/provider-runtime-capabilities.test.ts packages/server/_test/server.test.ts packages/server/_test/pipeline-helpers.ts packages/server/_test/cross-protocol-routing.test.ts packages/server/_test/dashboard-providers-mutation.test.ts
git commit -m "refactor(server): propagate provider baseURL" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 5: Migrate local configuration and verify the original regression

**Files:**
- Modify locally, never stage: `.aio-proxy-dev/config.jsonc`
- Verify repository-wide source and tests; no additional product source is planned.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: a locally valid configuration and evidence that the original loader error is gone.

- [ ] **Step 1: Migrate the ignored local API provider field**

In `.aio-proxy-dev/config.jsonc`, change the API provider entry only:

```json
"neeko": {
  "kind": "api",
  "protocol": "anthropic",
  "baseURL": "https://aidp.byteintl.net/api/modelhub/online/anthropic/v1"
}
```

Preserve the existing `apiKey`, models, aliases, ordering, and all other provider data. Do not add `options.name` to `carpool`; the runtime default is the behavior under test.

- [ ] **Step 2: Run the full preflight**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run preflight
```

Expected: formatting/checks and every workspace unit test PASS.

- [ ] **Step 3: Verify the development server is healthy after reload**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk curl -sS -i http://127.0.0.1:22078/health
```

Expected: HTTP 200 with JSON containing `"status":"ok"`.

- [ ] **Step 4: Re-run the original minimal request**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk proxy bun -e 'const r=await fetch("http://127.0.0.1:22078/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"gpt-5.6-sol",messages:[{role:"user",content:""}]})}); const text=await r.text(); console.log(JSON.stringify({status:r.status,body:text.slice(0,500)})); if(text.includes("@ai-sdk/openai-compatible requires name and baseURL")) throw new Error("configuration regression still reproduces");'
```

Expected: the command does not throw `configuration regression still reproduces`. A success response or a later upstream/auth/model error both prove the missing-name materialization failure is fixed; investigate any later error separately.

- [ ] **Step 5: Confirm the ignored local config is not staged**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git status --short
```

Expected: `.aio-proxy-dev/config.jsonc` is absent from Git status. Only intentional source/doc changes or commits are present.

- [ ] **Step 6: Finish without a verification-only commit**

The local migration and verification steps must not modify tracked files. If verification exposes a tracked defect, return to the task that owns that file, add the missing regression test and implementation there, rerun that task's checks, and amend its task-specific commit. Do not create an empty or catch-all verification commit.
