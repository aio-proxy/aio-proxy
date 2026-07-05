# GitHub Copilot OAuth Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build OAuth-backed GitHub Copilot providers that can login from the CLI, create stable `copilot-<github-user-id>` provider entries, sync Copilot models, and route requests through existing AI SDK transports with provider fallback.

**Architecture:** Rename the current `subscription` provider kind to `oauth`, then make OAuth providers look like AI SDK-capable runtime providers. GitHub Copilot owns OAuth, token refresh, `/models` sync, and Copilot headers; route files only iterate router candidates and retry on network errors, `429`, and `5xx`. CLI `provider login copilot` is only an I/O adapter over the shared OAuth login service.

**Tech Stack:** Bun test runner, TypeScript, Zod, Hono, existing `@aio-proxy/auth-flows` auth store, existing AI SDK provider loader (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`).

Design spec: `docs/superpowers/specs/2026-07-05-github-copilot-oauth-provider-design.md`

---

## File Structure

- `packages/types/src/provider.ts` and `packages/types/src/config.ts`: rename public config kind from `subscription` to `oauth`.
- `packages/core/src/index.ts`: change `Router` to return ordered provider candidates.
- `packages/server/src/route-dispatch.ts`: shared fallback helper for route files.
- `packages/auth-flows/src/oauth-provider.ts`: `BaseOAuthProvider`, login result types, provider id assembly, and auth payload storage helpers.
- `packages/auth-flows/src/github-copilot.ts`: GitHub Copilot device flow, token refresh, identity lookup, model sync, and Copilot header helpers.
- `packages/server/src/oauth-runtime.ts`: materialize configured OAuth providers into runtime provider instances.
- `packages/server/src/provider-runtime.ts` and `packages/server/src/runtime.ts`: replace the current inert OAuth runtime object with a real invoke-capable provider.
- `packages/cli/src/provider-commands.ts` and `packages/cli/src/main.ts`: add `provider login copilot`, update config, and call shared OAuth login service.

## Global Constraints

- Do not add `@ai-sdk/github-copilot`; it does not exist.
- Do not add a new database table; use the existing auth store.
- Do not implement dashboard login UI in this pass.
- Do not add env-token fallback or token import.
- Do not route or display Copilot models with `model_picker_enabled=false`.
- Keep `createServer()` synchronous; model sync is explicit from CLI login and lazy/background from runtime helpers.

---

### Task 1: Rename Provider Kind From Subscription To OAuth

**Files:**
- Modify: `packages/types/src/provider.ts`
- Modify: `packages/types/src/config.ts`
- Modify: `packages/types/_test/schemas.test.ts`
- Modify: `packages/core/_test/router.test.ts`
- Modify: `packages/server/src/runtime.ts`
- Modify: `packages/server/src/provider-runtime.ts`

- [ ] **Step 1: Write schema tests for `oauth` provider config**

In `packages/types/_test/schemas.test.ts`, replace the subscription tests with OAuth tests:

```ts
test("accepts oauth provider config", () => {
  const provider = {
    kind: "oauth",
    vendor: "github-copilot",
    models: ["gpt-5-mini"],
  };

  expect(ConfigSchema.parse({ server: {}, providers: { copilot: provider } })).toEqual({
    server: { host: "127.0.0.1", port: 22078 },
    providers: [{ ...provider, enabled: true, id: "copilot" }],
  });
});

test("accepts mixed provider config", () => {
  const input = {
    openai: apiProvider,
    copilot: { kind: "oauth", vendor: "github-copilot" },
    anthropic: { kind: "ai-sdk", packageName: "@ai-sdk/anthropic" },
  };

  expect(
    ConfigSchema.parse({
      server: { host: "0.0.0.0", port: 3000 },
      providers: input,
    }),
  ).toEqual({
    server: { host: "0.0.0.0", port: 3000 },
    providers: [
      { ...apiProvider, enabled: true, id: "openai" },
      { kind: "oauth", enabled: true, id: "copilot", vendor: "github-copilot" },
      { kind: "ai-sdk", enabled: true, id: "anthropic", packageName: "@ai-sdk/anthropic" },
    ],
  });
});

test("rejects invalid oauth vendor at providers.copilot.vendor", () => {
  expectIssuePath(
    {
      server: {},
      providers: { copilot: { kind: "oauth", vendor: "github" } },
    },
    ["providers", "copilot", "vendor"],
  );
});
```

- [ ] **Step 2: Run schema tests and confirm failure**

Run:

```bash
cd packages/types && bun test _test/schemas.test.ts
```

Expected: FAIL because `kind: "oauth"` is not accepted yet.

- [ ] **Step 3: Rename public provider schema and types**

In `packages/types/src/provider.ts`:

- Change `ProviderKind.Subscription = "subscription"` to `ProviderKind.OAuth = "oauth"`.
- Rename `SubscriptionProviderSchema` to `OAuthProviderSchema`.
- Rename `SubscriptionProviderInput` / `SubscriptionProvider` to `OAuthProviderInput` / `OAuthProvider`.
- Keep `vendor: z.literal("github-copilot")`.

In `packages/types/src/config.ts`, replace `SubscriptionProviderSchema` with `OAuthProviderSchema`.

- [ ] **Step 4: Update runtime OAuth names**

In `packages/server/src/runtime.ts`, rename `SubscriptionProviderInstance` to `OAuthProviderInstance`, with `kind: ProviderKind.OAuth`.

In `packages/server/src/provider-runtime.ts`, change the switch case to `ProviderKind.OAuth` and keep the existing inert object for this task.

- [ ] **Step 5: Update router test fixture**

In `packages/core/_test/router.test.ts`, change the Copilot fixture to:

```ts
const copilot = {
  kind: "oauth",
  id: "copilot",
  vendor: "github-copilot",
  models: [{ alias: "sonnet", id: "claude-sonnet-4-5" }],
} satisfies ProviderInstance;
```

- [ ] **Step 6: Run type/schema/router tests**

Run:

```bash
cd packages/types && bun test _test/schemas.test.ts
cd ../core && bun test _test/router.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/provider.ts packages/types/src/config.ts packages/types/_test/schemas.test.ts packages/core/_test/router.test.ts packages/server/src/runtime.ts packages/server/src/provider-runtime.ts
git commit -m "refactor(provider): rename subscription provider to oauth"
```

---

### Task 2: Make Router Return Ordered Candidates

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/_test/router.test.ts`

- [ ] **Step 1: Replace collision test with fallback candidate tests**

In `packages/core/_test/router.test.ts`, replace `"throws a collision error including both provider ids"` with:

```ts
test("returns ordered candidates for duplicate aliases", () => {
  const other = {
    kind: "api",
    id: "other",
    protocol: ProviderProtocol.OpenAICompatible,
    models: [{ alias: "mini", id: "other-mini" }],
  } satisfies ProviderInstance;

  const router = new Router([openai, other]);

  expect(router.resolve("mini")).toEqual([
    { provider: openai, modelId: "gpt-5-mini" },
    { provider: other, modelId: "other-mini" },
  ]);
});

test("provider-qualified aliases only return the requested provider", () => {
  const other = {
    kind: "api",
    id: "other",
    protocol: ProviderProtocol.OpenAICompatible,
    models: [{ alias: "mini", id: "other-mini" }],
  } satisfies ProviderInstance;

  const router = new Router([openai, other]);

  expect(router.resolve("other/mini")).toEqual([{ provider: other, modelId: "other-mini" }]);
});
```

Update existing tests that call `router.resolve(...)` to expect an array with one item, for example:

```ts
expect(resolved).toEqual([{ provider: openai, modelId: "gpt-5-mini" }]);
```

Keep `"rejects duplicate provider-specific aliases"` because duplicate aliases inside the same provider remain invalid.

- [ ] **Step 2: Run router test and confirm failure**

Run:

```bash
cd packages/core && bun test _test/router.test.ts
```

Expected: FAIL because `Router.resolve()` still returns one object and rejects cross-provider duplicates.

- [ ] **Step 3: Implement candidate lists**

In `packages/core/src/index.ts`:

- Change `RouterResolution` usage so `resolve(model: string)` returns `readonly RouterResolution<TProvider>[]`.
- Change `aliases` and `providerAliases` maps to store arrays.
- In `addRoute`, keep throwing when the same provider-specific alias already exists.
- For unqualified aliases, append the route instead of throwing when the existing provider id differs.

The core logic should look like:

```ts
resolve(model: string): readonly RouterResolution<TProvider>[] {
  const routes = model.indexOf("/") > 0 ? this.providerAliases.get(model) : this.aliases.get(model);

  if (routes === undefined || routes.length === 0) {
    throw new RouterModelNotFoundError(model);
  }

  return routes;
}
```

and:

```ts
const providerAlias = `${provider.id}/${model.alias}`;
if (this.providerAliases.has(providerAlias)) {
  throw new RouterModelCollisionError(model.alias, provider.id, provider.id);
}

this.providerAliases.set(providerAlias, [route]);
this.aliases.set(model.alias, [...(this.aliases.get(model.alias) ?? []), route]);
```

- [ ] **Step 4: Run router tests**

Run:

```bash
cd packages/core && bun test _test/router.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/_test/router.test.ts
git commit -m "feat(router): return ordered provider candidates"
```

---

### Task 3: Add Shared Route Fallback Dispatch

**Files:**
- Create: `packages/server/src/route-dispatch.ts`
- Modify: `packages/server/src/routes/openai-completions.ts`
- Modify: `packages/server/src/routes/openai-responses.ts`
- Modify: `packages/server/src/routes/anthropic-messages.ts`
- Modify: `packages/server/src/routes/gemini-generate-content.ts`
- Modify: `packages/server/_test/openai-completions.test.ts`

- [ ] **Step 1: Add fallback tests for OpenAI completions**

In `packages/server/_test/openai-completions.test.ts`, add two tests near the existing provider dispatch tests:

```ts
test("Given first provider returns 429 When completion is posted Then next provider is used", async () => {
  const first = {
    enabled: true,
    id: "rate-limited",
    kind: "api" as const,
    protocol: ProviderProtocol.OpenAICompatible,
    models: ["gpt-5-mini"],
    passthrough: async () => Response.json({ error: "rate limited" }, { status: 429 }),
  };
  const second = {
    enabled: true,
    id: "ok",
    kind: "ai-sdk" as const,
    models: ["gpt-5-mini"],
    invoke: () =>
      textStream([
        { type: "text-delta", id: "fallback", text: "fallback ok" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ]),
  };
  const app = createServer({ config: { providers: {} }, providerInstances: [first, second] });

  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }] }),
  });

  const body = await response.json();
  expect(response.status).toBe(200);
  expect(JSON.stringify(body)).toContain("fallback ok");
});

test("Given first provider returns 400 When completion is posted Then no fallback occurs", async () => {
  let secondCalled = false;
  const first = {
    enabled: true,
    id: "bad-request",
    kind: "api" as const,
    protocol: ProviderProtocol.OpenAICompatible,
    models: ["gpt-5-mini"],
    passthrough: async () => Response.json({ error: "bad request" }, { status: 400 }),
  };
  const second = {
    enabled: true,
    id: "ok",
    kind: "ai-sdk" as const,
    models: ["gpt-5-mini"],
    invoke: () => {
      secondCalled = true;
      return textStream([
        { type: "text-delta", id: "fallback", text: "fallback ok" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ]);
    },
  };
  const app = createServer({ config: { providers: {} }, providerInstances: [first, second] });

  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }] }),
  });

  expect(response.status).toBe(400);
  expect(secondCalled).toBe(false);
});
```

Use the existing `textStream` helper at the top of `packages/server/_test/openai-completions.test.ts`.

- [ ] **Step 2: Run targeted server test and confirm failure**

Run:

```bash
cd packages/server && bun test _test/openai-completions.test.ts
```

Expected: FAIL because route code still expects a single router resolution.

- [ ] **Step 3: Create shared dispatch helper**

Create `packages/server/src/route-dispatch.ts`:

```ts
import { bridgeApiProviderToAiSdk, RouterModelNotFoundError } from "@aio-proxy/core";
import { ProviderKind } from "@aio-proxy/types";
import type { RouterResolution } from "@aio-proxy/core";
import type { ProviderRouteSource, RuntimeProviderInstance } from "./runtime";

export type RouteDispatchResult = Response | undefined;

export function resolveCandidates(source: ProviderRouteSource, model: string): readonly RouterResolution<RuntimeProviderInstance>[] | RouterModelNotFoundError {
  try {
    return source.currentProviderSnapshot().router.resolve(model);
  } catch (error) {
    if (error instanceof RouterModelNotFoundError) {
      return error;
    }
    throw error;
  }
}

export function shouldTryNextResponse(response: Response): boolean {
  return response.status === 429 || response.status >= 500;
}

export function toAiSdkProvider(provider: RuntimeProviderInstance): Extract<RuntimeProviderInstance, { kind: ProviderKind.AiSdk }> | undefined {
  if (provider.kind === ProviderKind.AiSdk) {
    return provider;
  }
  if (provider.kind === ProviderKind.Api) {
    return bridgeApiProviderToAiSdk({
      ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      id: provider.id,
      kind: provider.kind,
      ...(provider.models === undefined ? {} : { models: [...provider.models] }),
      protocol: provider.protocol,
    });
  }
  if (provider.kind === ProviderKind.OAuth) {
    return provider;
  }
  return undefined;
}
```

- [ ] **Step 4: Update route files to iterate candidates**

In each route file:

- Replace `const route = resolveRoute(source, request.model)` with `const candidates = resolveCandidates(source, request.model)`.
- If `candidates` is a `RouterModelNotFoundError`, return the existing protocol-specific 404 response.
- Iterate candidates in order.
- For same-protocol raw API passthrough, return response immediately unless `shouldTryNextResponse(response)` is true and another candidate exists.
- For transformed AI SDK dispatch, call `toAiSdkProvider(route.provider)`.
- If a candidate cannot support the transform, remember the protocol-specific `501` response and try the next candidate.
- If `ensureAvailable` or invoke throws before response streaming begins, remember the protocol-specific provider error and try the next candidate.
- Return the last remembered response when all candidates fail.

Keep the existing protocol-specific error body helpers; do not introduce a new public error envelope.

- [ ] **Step 5: Run targeted route tests**

Run:

```bash
cd packages/server && bun test _test/openai-completions.test.ts _test/openai-responses.test.ts _test/anthropic-messages.test.ts _test/gemini-generate-content.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/route-dispatch.ts packages/server/src/routes packages/server/_test/openai-completions.test.ts
git commit -m "feat(server): fallback across provider candidates"
```

---

### Task 4: Add OAuth Base Provider And GitHub Copilot Flow

**Files:**
- Create: `packages/auth-flows/src/oauth-provider.ts`
- Create: `packages/auth-flows/src/github-copilot.ts`
- Modify: `packages/auth-flows/src/index.ts`
- Create: `packages/auth-flows/_test/github-copilot.test.ts`

- [ ] **Step 1: Add GitHub Copilot tests with fake fetch**

Create `packages/auth-flows/_test/github-copilot.test.ts` with tests that cover:

- device login returns provider id `copilot-12345`;
- `GET /user` `email: null` still succeeds by using numeric `id`;
- `/models` filters out `model_picker_enabled=false`;
- token `proxy-ep=proxy.individual.githubcopilot.com` becomes `https://api.individual.githubcopilot.com`.

Use a fake `fetch` dependency rather than network calls:

```ts
import { describe, expect, test } from "bun:test";
import { GitHubCopilotOAuthProvider } from "../src/github-copilot";

test("login creates provider id from GitHub numeric user id", async () => {
  const provider = new GitHubCopilotOAuthProvider({
    fetch: fakeCopilotFetch(),
    now: () => 1_000,
    sleep: async () => undefined,
  });

  const result = await provider.login({
    onAuth: () => undefined,
    onProgress: () => undefined,
  });

  expect(result.providerId).toBe("copilot-12345");
  expect(result.userId).toBe("12345");
  expect(result.accountLabel).toBe("octocat");
  expect(result.payload.baseUrl).toBe("https://api.individual.githubcopilot.com");
});
```

The fake fetch should return:

- `/login/device/code`: `{ device_code: "device", user_code: "ABCD", verification_uri: "https://github.com/login/device", interval: 0, expires_in: 600 }`
- `/login/oauth/access_token`: `{ access_token: "github-token" }`
- `/copilot_internal/v2/token`: `{ token: "tid=x;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;", expires_at: 9999999999 }`
- `/user`: `{ id: 12345, login: "octocat", email: null }`
- `/models`: a `data` array with one picker-enabled chat model and one picker-disabled model.
- `/models/<id>/policy`: status 200.

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
cd packages/auth-flows && bun test _test/github-copilot.test.ts
```

Expected: FAIL because the new provider files do not exist.

- [ ] **Step 3: Implement `BaseOAuthProvider`**

Create `packages/auth-flows/src/oauth-provider.ts`:

```ts
import { Auth } from "./store";

export type OAuthLoginCallbacks = {
  readonly onAuth: (info: { readonly url: string; readonly instructions?: string }) => void;
  readonly onProgress?: (message: string) => void;
  readonly signal?: AbortSignal;
};

export type OAuthLoginPayload = {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly [key: string]: unknown;
};

export type OAuthProviderLoginResult<TPayload extends OAuthLoginPayload = OAuthLoginPayload> = {
  readonly accountLabel?: string;
  readonly payload: TPayload;
  readonly providerId: string;
  readonly status: "authenticated";
  readonly userId: string;
};

export abstract class BaseOAuthProvider<TPayload extends OAuthLoginPayload = OAuthLoginPayload> {
  protected constructor(
    readonly vendor: string,
    private readonly prefix: string,
  ) {}

  protected providerId(userId: string): string {
    return `${this.prefix}-${userId}`;
  }

  protected store(providerId: string, payload: TPayload, accountLabel?: string): void {
    Auth.set(this.vendor, providerId, { ...payload, accountLabel }, providerId);
  }

  abstract login(callbacks: OAuthLoginCallbacks): Promise<OAuthProviderLoginResult<TPayload>>;
}
```

- [ ] **Step 4: Implement GitHub Copilot flow**

Create `packages/auth-flows/src/github-copilot.ts` with:

- `normalizeDomain(input: string): string | null`
- `getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string`
- `GitHubCopilotOAuthProvider`
- exported `githubCopilotOAuthProvider = new GitHubCopilotOAuthProvider()`

Implementation requirements:

- Use `CLIENT_ID = "Iv1.b507a08c87ecfe98"`.
- Use `scope=read:user`.
- Poll `/login/oauth/access_token` until access token, `authorization_pending`, `slow_down`, timeout, or abort.
- Refresh Copilot token through `/copilot_internal/v2/token`.
- Call GitHub `GET /user` with the GitHub token and parse `id` as string `userId`; use `login` as `accountLabel`.
- Store payload shape `{ refresh, access, expires, enterpriseUrl, baseUrl, models, syncedAt }`.
- Call `this.store(providerId, payload, accountLabel)` before returning from successful login, so callers do not duplicate auth persistence.
- Convert each picker-enabled chat model to `{ alias, id, transport }`, where `transport` is `"messages"` for `/v1/messages`, `"responses"` for `/responses`, and `"chat"` for `/chat/completions`.
- Filter out models that are not picker-enabled, are not chat-capable, or do not expose one of those three supported endpoints.

- [ ] **Step 5: Export new APIs**

In `packages/auth-flows/src/index.ts`, export:

```ts
export { BaseOAuthProvider, type OAuthLoginCallbacks, type OAuthProviderLoginResult } from "./oauth-provider";
export {
  GitHubCopilotOAuthProvider,
  getGitHubCopilotBaseUrl,
  githubCopilotOAuthProvider,
  normalizeDomain,
} from "./github-copilot";
```

- [ ] **Step 6: Run auth-flow tests**

Run:

```bash
cd packages/auth-flows && bun test _test/store.test.ts _test/github-copilot.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/auth-flows/src packages/auth-flows/_test/github-copilot.test.ts
git commit -m "feat(auth): add github copilot oauth flow"
```

---

### Task 5: Materialize OAuth Providers At Runtime

**Files:**
- Create: `packages/server/src/oauth-runtime.ts`
- Modify: `packages/server/src/runtime.ts`
- Modify: `packages/server/src/provider-runtime.ts`
- Modify: `packages/server/src/provider-availability.ts`
- Create: `packages/server/_test/oauth-provider-runtime.test.ts`

- [ ] **Step 1: Add runtime test**

Create `packages/server/_test/oauth-provider-runtime.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "@aio-proxy/auth-flows";
import { ConfigSchema, ProviderKind } from "@aio-proxy/types";
import { materializeProviders } from "../src/provider-runtime";

describe("OAuth provider runtime", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aio-proxy-oauth-runtime-"));
    process.env.AIO_PROXY_HOME = dir;
    return () => {
      delete process.env.AIO_PROXY_HOME;
      rmSync(dir, { recursive: true, force: true });
    };
  });

  test("materializes cached Copilot models as invoke-capable OAuth provider", () => {
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
      syncedAt: Date.now(),
    });

    const runtime = materializeProviders(
      ConfigSchema.parse({
        providers: {
          "copilot-12345": { kind: "oauth", vendor: "github-copilot" },
        },
      }),
    );

    expect(runtime.providers[0]).toMatchObject({
      id: "copilot-12345",
      kind: ProviderKind.OAuth,
      models: [
        { alias: "gpt-5-mini", id: "gpt-5-mini" },
        { alias: "claude-sonnet-4", id: "claude-sonnet-4" },
        { alias: "gpt-5", id: "gpt-5" },
      ],
    });
    expect("invoke" in runtime.providers[0]!).toBe(true);
    expect(runtime.providers[0]!.models).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
cd packages/server && bun test _test/oauth-provider-runtime.test.ts
```

Expected: FAIL because OAuth runtime materialization is still inert.

- [ ] **Step 3: Define OAuth runtime instance**

In `packages/server/src/runtime.ts`, make `OAuthProviderInstance` include:

```ts
readonly ensureAvailable?: () => Promise<void>;
readonly invoke: AiSdkProviderInstance["invoke"];
```

Import `AiSdkProviderInstance` from `@aio-proxy/core`.

- [ ] **Step 4: Implement `createGitHubCopilotRuntimeProvider`**

Create `packages/server/src/oauth-runtime.ts`:

```ts
import { Auth } from "@aio-proxy/auth-flows";
import { createAiSdkProvider } from "@aio-proxy/core";
import { ProviderKind } from "@aio-proxy/types";
import type { ModelEntry, OAuthProvider } from "@aio-proxy/types";
import type { OAuthProviderInstance } from "./runtime";

export function createGitHubCopilotRuntimeProvider(config: OAuthProvider): OAuthProviderInstance {
  const row = Auth.get(config.vendor, config.id);
  const payload = row?.payload as {
    access?: unknown;
    baseUrl?: unknown;
    models?: unknown;
  } | null;
  const cachedModels = cachedCopilotModels(payload?.models);
  const modelEntries = cachedModels === undefined ? config.models : cachedModels.map(({ alias, id }) => ({ alias, id }));
  const transportByModelId = new Map(cachedModels?.map(({ id, transport }) => [id, transport]));
  const access = typeof payload?.access === "string" ? payload.access : undefined;
  const baseUrl = typeof payload?.baseUrl === "string" ? payload.baseUrl : undefined;
  const providers = {
    chat: createAiSdkProvider(
      aiConfig(config, "@ai-sdk/openai-compatible", {
        apiKey: access,
        baseURL: baseUrl,
        headers: copilotHeaders(),
        name: config.id,
      }),
    ),
    messages: createAiSdkProvider(
      aiConfig(config, "@ai-sdk/anthropic", {
        apiKey: access,
        baseURL: baseUrl === undefined ? undefined : `${baseUrl}/v1`,
        headers: copilotHeaders(),
      }),
    ),
    responses: createAiSdkProvider(
      aiConfig(config, "@ai-sdk/openai", {
        apiKey: access,
        baseURL: baseUrl,
        headers: copilotHeaders(),
      }),
    ),
  } as const;

  return {
    enabled: config.enabled,
    id: config.id,
    kind: ProviderKind.OAuth,
    ...(modelEntries === undefined ? {} : { models: modelEntries }),
    vendor: config.vendor,
    async ensureAvailable() {
      if (access === undefined || baseUrl === undefined) {
        throw new Error(`${config.id}: GitHub Copilot login required`);
      }
    },
    invoke(request) {
      return providers[transportFor(transportByModelId, request.modelId)].invoke(request);
    },
  };
}

type CachedCopilotModel = ModelEntry & {
  readonly transport: "chat" | "messages" | "responses";
};

function cachedCopilotModels(value: unknown): CachedCopilotModel[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((model): model is CachedCopilotModel => {
    if (typeof model !== "object" || model === null) {
      return false;
    }
    const candidate = model as Record<string, unknown>;
    return (
      typeof candidate.alias === "string" &&
      typeof candidate.id === "string" &&
      (candidate.transport === "chat" || candidate.transport === "messages" || candidate.transport === "responses")
    );
  });
}

function aiConfig(
  config: OAuthProvider,
  packageName: "@ai-sdk/openai-compatible" | "@ai-sdk/anthropic" | "@ai-sdk/openai",
  options: Record<string, unknown>,
) {
  return {
    enabled: config.enabled,
    id: config.id,
    kind: ProviderKind.AiSdk,
    packageName,
    options,
  } as const;
}

function transportFor(
  transportByModelId: ReadonlyMap<string, "chat" | "messages" | "responses">,
  modelId: string,
): "chat" | "messages" | "responses" {
  return transportByModelId.get(modelId) ?? "chat";
}

function copilotHeaders(): Record<string, string> {
  return {
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Editor-Version": "vscode/1.107.0",
    "User-Agent": "GitHubCopilotChat/0.35.0",
  };
}
```

This runtime bridge must preserve transport metadata from the model cache. The public `/v1/models` endpoint still emits only model aliases; `transport` stays internal to OAuth runtime selection.

- [ ] **Step 5: Use OAuth runtime in provider materialization**

In `packages/server/src/provider-runtime.ts`, import `createGitHubCopilotRuntimeProvider` and change the OAuth case:

```ts
case ProviderKind.OAuth: {
  const instance = createGitHubCopilotRuntimeProvider(provider);
  probes.set(id, () => probeAiSdk(instance));
  providers.push(instance);
  summaries.push(providerSummary(instance));
  break;
}
```

In `packages/server/src/provider-availability.ts`, allow `ProviderKind.OAuth` wherever an invoke-capable provider is accepted.

- [ ] **Step 6: Run runtime test**

Run:

```bash
cd packages/server && bun test _test/oauth-provider-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/oauth-runtime.ts packages/server/src/runtime.ts packages/server/src/provider-runtime.ts packages/server/src/provider-availability.ts packages/server/_test/oauth-provider-runtime.test.ts
git commit -m "feat(server): materialize oauth providers"
```

---

### Task 6: Add CLI `provider login copilot`

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/provider-commands.ts`
- Create: `packages/cli/src/config-path.ts`
- Modify: `packages/cli/_test/provider-commands.test.ts`

- [ ] **Step 1: Add CLI login test**

In `packages/cli/_test/provider-commands.test.ts`, add a test that runs with a temp config:

```ts
test("provider login copilot writes provider config returned by login service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aio-proxy-cli-login-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: {} }));

  try {
    const result = await runCliAsync(["provider", "login", "copilot", "--config", configPath], {
      AIO_PROXY_TEST_COPILOT_LOGIN: JSON.stringify({
        providerId: "copilot-12345",
        payload: {
          access: "copilot-token",
          refresh: "github-token",
          expires: Date.now() + 60_000,
          baseUrl: "https://api.individual.githubcopilot.com",
          models: [{ alias: "gpt-5-mini", id: "gpt-5-mini", transport: "chat" }],
          syncedAt: Date.now(),
        },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(await Bun.file(configPath).json()).toEqual({
      providers: {
        "copilot-12345": { kind: "oauth", vendor: "github-copilot" },
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run CLI test and confirm failure**

Run:

```bash
cd packages/cli && bun test _test/provider-commands.test.ts
```

Expected: FAIL because `provider login` does not exist.

- [ ] **Step 3: Move config path helper**

Create `packages/cli/src/config-path.ts`:

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export const defaultConfigPath = () => {
  const appData = process.env["APPDATA"];
  if (process.platform === "win32" && appData !== undefined) {
    return join(appData, "aio-proxy", "config.jsonc");
  }
  return join(homedir(), ".config", "aio-proxy", "config.jsonc");
};

export const resolveConfigPath = (optionPath: string | undefined) =>
  optionPath ?? process.env["AIO_PROXY_CONFIG"] ?? defaultConfigPath();
```

In `packages/cli/src/main.ts`, delete the local `defaultConfigPath` and `resolveConfigPath` declarations and import:

```ts
import { resolveConfigPath } from "./config-path";
```

- [ ] **Step 4: Implement provider login**

In `packages/cli/src/provider-commands.ts`, add:

```ts
import { Auth, githubCopilotOAuthProvider } from "@aio-proxy/auth-flows";
import { resolveConfigPath } from "./config-path";

export type ProviderLoginOptions = {
  readonly config?: string;
};

type LoginForCliResult = {
  readonly payload: Record<string, unknown>;
  readonly providerId: string;
};

export async function providerLogin(family: string, options: ProviderLoginOptions): Promise<void> {
  if (family !== "copilot") {
    console.error(`unknown oauth provider family: ${family}`);
    process.exitCode = 1;
    return;
  }

  const result = await runCopilotLoginForCli();
  const configPath = resolveConfigPath(options.config);
  const config = JSON.parse(await Bun.file(configPath).text()) as { providers?: Record<string, unknown> };
  const providers = config.providers ?? {};
  providers[result.providerId] = { kind: "oauth", vendor: "github-copilot" };
  await Bun.write(configPath, `${JSON.stringify({ ...config, providers }, null, 2)}\n`);
  console.log(result.providerId);
}

async function runCopilotLoginForCli(): Promise<LoginForCliResult> {
  const fake = process.env["AIO_PROXY_TEST_COPILOT_LOGIN"];
  if (fake !== undefined) {
    const result = JSON.parse(fake) as LoginForCliResult;
    Auth.set("github-copilot", result.providerId, result.payload, result.providerId);
    return result;
  }
  const result = await githubCopilotOAuthProvider.login({
    onAuth: ({ url, instructions }) => {
      console.log(url);
      if (instructions !== undefined) {
        console.log(instructions);
      }
    },
    onProgress: (message) => console.error(message),
  });
  return { payload: result.payload, providerId: result.providerId };
}
```

- [ ] **Step 5: Wire command**

In `packages/cli/src/main.ts`, import `providerLogin` and add:

```ts
provider.command("login <family>").option("--config <path>", m.cli_serve_option_config_description()).action(providerLogin);
```

- [ ] **Step 6: Run CLI test**

Run:

```bash
cd packages/cli && bun test _test/provider-commands.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/main.ts packages/cli/src/provider-commands.ts packages/cli/src/config-path.ts packages/cli/_test/provider-commands.test.ts
git commit -m "feat(cli): add copilot provider login"
```

---

### Task 7: Full Verification

**Files:**
- No planned edits in this task.

- [ ] **Step 1: Run focused package tests**

Run:

```bash
cd packages/types && bun test _test/schemas.test.ts
cd ../core && bun test _test/router.test.ts _test/provider/ai-sdk.test.ts _test/provider/api-bridge.test.ts
cd ../auth-flows && bun test _test/store.test.ts _test/github-copilot.test.ts
cd ../server && bun test _test/oauth-provider-runtime.test.ts _test/openai-completions.test.ts _test/openai-responses.test.ts _test/anthropic-messages.test.ts _test/gemini-generate-content.test.ts
cd ../cli && bun test _test/provider-commands.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run repo checks**

Run from repo root:

```bash
bun run check
bun run test:unit
```

Expected: both PASS.

- [ ] **Step 3: Inspect diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: no unstaged implementation changes after all previous task commits.
