# xAI Grok OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in xAI Grok OAuth plugin that logs in with RFC 8628, discovers account models, invokes them through Grok CLI proxy, and reads the account's credits quota.

**Architecture:** A new `packages/plugins/xai-grok` workspace owns OAuth, catalog, runtime, quota, and descriptor behavior. It uses the existing OAuth adapter and credential port, the installed `@ai-sdk/openai` Responses provider, official `/v1/models` for discovery, CPA-compatible CLI proxy headers for inference, and CodexBar's verified Grok web billing call for read-only quota; core only embeds the descriptor.

**Tech Stack:** Bun, TypeScript, `@aio-proxy/plugin-sdk`, `@ai-sdk/openai`, Rslib, Bun test.

## Global Constraints

- Provider ID terminology and Provider weight behavior remain unchanged.
- Runtime endpoint is exactly `https://cli-chat-proxy.grok.com/v1`; model discovery is exactly `https://api.x.ai/v1/models`.
- OAuth scopes are exactly `openid profile email offline_access grok-cli:access api:access`.
- No xAI API-key mode, endpoint option, raw capability, media, websocket, compact, quota reset, reset-credit inventory, account pool, or shared OAuth abstraction.
- Reuse installed dependencies; add no external dependency.
- Keep every handwritten source and test file below 300 lines.
- Every non-trivial behavior follows RED → verify failure → minimal GREEN → verify pass.
- Preserve the user's untracked `.reference` symlink and unrelated worktree changes.

---

## File Map

- `packages/plugins/xai-grok/src/schema.ts`: persisted credential schema and type.
- `packages/plugins/xai-grok/src/oauth.ts`: discovery, device flow, refresh, identity, and credential-port refresh.
- `packages/plugins/xai-grok/src/oauth/http.ts`: private OAuth HTTP/form transport and retryable status classification.
- `packages/plugins/xai-grok/src/catalog.ts`: official model discovery, filtering, curated fallback, and catalog errors.
- `packages/plugins/xai-grok/src/runtime.ts`: Responses ProviderV4 and CLI proxy fetch wrapper.
- `packages/plugins/xai-grok/src/quota-protobuf.ts`: bounded gRPC-Web framing and protobuf billing scanner.
- `packages/plugins/xai-grok/src/quota.ts`: authenticated Grok web billing request and quota snapshot mapping.
- `packages/plugins/xai-grok/src/plugin.ts`: OAuth adapter and injectable presentation/dependencies.
- `packages/plugins/xai-grok/src/index.ts`: package exports, version, and default descriptor.
- Colocated `*.test.ts`: behavior tests for each source responsibility.
- Package config files: build/test/export metadata only.
- `packages/core/src/plugins/builtins.ts` and `.test.ts`: built-in embedding and localized copy.
- `packages/core/package.json`, `bun.lock`: workspace dependency resolution.

### Task 1: OAuth credential lifecycle

**Files:**
- Create: `packages/plugins/xai-grok/package.json`
- Create: `packages/plugins/xai-grok/tsconfig.json`
- Create: `packages/plugins/xai-grok/rslib.config.ts`
- Create: `packages/plugins/xai-grok/src/schema.ts`
- Create: `packages/plugins/xai-grok/src/oauth.ts`
- Create: `packages/plugins/xai-grok/src/oauth/http.ts`
- Test: `packages/plugins/xai-grok/src/oauth.test.ts`

**Interfaces:**
- Consumes: `OAuthLoginContext`, `CredentialPort`, and `CredentialRefreshError` from `@aio-proxy/plugin-sdk`.
- Produces: `loginXAIGrok(context, options)`, `refreshXAIGrokCredential(credential, options)`, `currentXAIGrokCredential(port, options)`, `validateXAIEndpoint(url, field)`, and `XAIGrokCredential`.

- [x] **Step 1: Create package metadata and the failing OAuth behavior test**

Create `packages/plugins/xai-grok/package.json`:

```json
{
  "name": "@aio-proxy/plugin-xai-grok",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "files": ["dist"],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "rslib",
    "test": "bun run test:unit",
    "test:unit": "bun test",
    "test:artifact": "bun test ./oauth.smoke.ts"
  },
  "dependencies": {
    "@aio-proxy/plugin-sdk": "workspace:*",
    "@ai-sdk/openai": "catalog:"
  },
  "devDependencies": {
    "@aio-proxy/infra": "workspace:*",
    "@rslib/core": "catalog:",
    "@types/bun": "catalog:",
    "typescript": "catalog:"
  }
}
```

Create `packages/plugins/xai-grok/tsconfig.json`:

```json
{
  "extends": "@aio-proxy/infra/tsconfig/base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "types": ["bun"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

Create `packages/plugins/xai-grok/rslib.config.ts`:

```ts
import { defineLibraryConfig } from "@aio-proxy/infra/rslib";

export default defineLibraryConfig();
```

Create `packages/plugins/xai-grok/src/oauth.test.ts` with these complete cases:

```ts
import { describe, expect, test } from "bun:test";
import type { OAuthLoginContext } from "@aio-proxy/plugin-sdk";
import {
  currentXAIGrokCredential,
  loginXAIGrok,
  refreshXAIGrokCredential,
  validateXAIEndpoint,
} from "./oauth";

const DISCOVERY = "https://auth.x.ai/.well-known/openid-configuration";
const DEVICE = "https://auth.x.ai/oauth2/device/code";
const TOKEN = "https://auth.x.ai/oauth2/token";

describe("xAI Grok OAuth", () => {
  test("performs device authorization and returns a stable private identity", async () => {
    const requests: Request[] = [];
    const presented: unknown[] = [];
    const fetcher = sequenceFetch(requests, [
      Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
      Response.json({
        device_code: "device-1",
        user_code: "CODE-1",
        verification_uri: "https://auth.x.ai/activate",
        verification_uri_complete: "https://auth.x.ai/activate?user_code=CODE-1",
        expires_in: 600,
        interval: 1,
      }),
      Response.json({ error: "authorization_pending" }, { status: 400 }),
      Response.json({ error: "slow_down" }, { status: 400 }),
      Response.json({
        access_token: jwt({ sub: "subject-1", email: "Person@Example.com" }),
        refresh_token: "refresh-1",
        expires_in: 3600,
      }),
    ]);
    const sleeps: number[] = [];
    const result = await loginXAIGrok(loginContext(presented), {
      fetch: fetcher,
      now: () => 1_700_000_000_000,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      deviceInstructions: "Enter code",
      waitingForAuthorization: "Waiting for xAI authorization",
    });

    expect(requests.map((request) => request.url)).toEqual([DISCOVERY, DEVICE, TOKEN, TOKEN, TOKEN]);
    expect(Object.fromEntries(await requests[1]!.formData())).toEqual({
      client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      scope: "openid profile email offline_access grok-cli:access api:access",
    });
    expect(presented).toEqual([{
      url: "https://auth.x.ai/activate?user_code=CODE-1",
      userCode: "CODE-1",
      instructions: "Enter code CODE-1",
    }]);
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(result).toEqual({
      fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      suggestedKey: expect.stringMatching(/^grok-[a-f0-9]{12}$/u),
      label: "Person@Example.com",
      credentials: {
        accessToken: jwt({ sub: "subject-1", email: "Person@Example.com" }),
        refreshToken: "refresh-1",
        expiresAt: 1_700_003_600_000,
        email: "Person@Example.com",
        subject: "subject-1",
      },
      expiresAt: 1_700_003_600_000,
    });
  });

  test("rejects discovered endpoints outside x.ai before sending credentials", () => {
    expect(() => validateXAIEndpoint("http://auth.x.ai/token", "token_endpoint")).toThrow("Invalid xAI");
    expect(() => validateXAIEndpoint("https://x.ai.evil.test/token", "token_endpoint")).toThrow("Invalid xAI");
    expect(validateXAIEndpoint(TOKEN, "token_endpoint")).toBe(TOKEN);
  });

  test("propagates cancellation into discovery", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    controller.abort(reason);
    const context = loginContext([]);
    const login = loginXAIGrok({ ...context, signal: controller.signal }, {
      fetch: async (_input, init) => {
        init?.signal?.throwIfAborted();
        throw new Error("aborted discovery must not return");
      },
    });
    await expect(login).rejects.toBe(reason);
  });

  test("stops polling after the device code expires", async () => {
    let now = 0;
    const login = loginXAIGrok(loginContext([]), {
      fetch: sequenceFetch([], [
        Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
        Response.json({
          device_code: "device-1",
          user_code: "CODE-1",
          verification_uri: "https://auth.x.ai/activate",
          expires_in: 1,
          interval: 1,
        }),
        Response.json({ error: "authorization_pending" }, { status: 400 }),
      ]),
      now: () => { now += 1_000; return now; },
      sleep: async () => {},
    });
    await expect(login).rejects.toThrow("timed out");
  });

  test("keeps an omitted refresh token and classifies invalid_grant as non-retryable", async () => {
    const credential = {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 0,
      email: "person@example.com",
      subject: "subject-1",
    };
    const refreshed = await refreshXAIGrokCredential(credential, {
      fetch: sequenceFetch([], [
        Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
        Response.json({ access_token: "new-access", expires_in: 60 }),
      ]),
      now: () => 1_700_000_000_000,
    });
    expect(refreshed).toEqual({ ...credential, accessToken: "new-access", expiresAt: 1_700_000_060_000 });

    const rejected = refreshXAIGrokCredential(credential, {
      fetch: sequenceFetch([], [
        Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      ]),
    });
    await expect(rejected).rejects.toMatchObject({ retryable: false, options: { reason: "invalid_grant" } });

    const unavailable = refreshXAIGrokCredential(credential, {
      fetch: sequenceFetch([], [
        Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
        new Response(null, { status: 503 }),
      ]),
    });
    await expect(unavailable).rejects.toMatchObject({ retryable: true, options: { reason: "upstream_5xx" } });
  });

  test("refreshes through the host credential port inside the five-minute window", async () => {
    let metadata: unknown;
    const expired = { accessToken: "old", refreshToken: "refresh", expiresAt: 0 };
    const value = await currentXAIGrokCredential({
      read: async () => ({ revision: 4, value: expired }),
      refresh: async (revision, exchange) => {
        const updated = await exchange({ revision, value: expired }, new AbortController().signal);
        metadata = updated.metadata;
        return { status: "updated", snapshot: { revision: revision + 1, value: updated.value } };
      },
    }, {
      fetch: sequenceFetch([], [
        Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
        Response.json({ access_token: "new", expires_in: 60 }),
      ]),
      now: () => 1_700_000_000_000,
    });
    expect(value.accessToken).toBe("new");
    expect(metadata).toEqual({ expiresAt: 1_700_000_060_000 });
  });
});

function loginContext(presented: unknown[]): OAuthLoginContext {
  return {
    authorization: {
      presentDeviceCode: async (input) => { presented.push(input); },
      loopback: async () => { throw new Error("device flow must not use loopback"); },
    },
    progress: () => {},
    signal: new AbortController().signal,
  };
}

function sequenceFetch(requests: Request[], responses: Response[]): typeof fetch {
  return async (input, init) => {
    requests.push(new Request(input, init));
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected request");
    return response;
  };
}

function jwt(payload: object): string {
  return ["header", Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(".");
}
```

- [x] **Step 2: Run the OAuth test and verify RED**

Run:

```bash
rtk bun test packages/plugins/xai-grok/src/oauth.test.ts
```

Expected: FAIL because `./oauth` does not exist.

- [x] **Step 3: Implement the minimal credential schema and OAuth flow**

Create `packages/plugins/xai-grok/src/schema.ts`:

```ts
import { zod } from "@aio-proxy/plugin-sdk";

export const credentialSchema = zod.object({
  accessToken: zod.string().min(1),
  refreshToken: zod.string().min(1),
  expiresAt: zod.number(),
  email: zod.string().min(1).optional(),
  subject: zod.string().min(1).optional(),
});

export type XAIGrokCredential = zod.infer<typeof credentialSchema>;
```

Create `packages/plugins/xai-grok/src/oauth.ts` with these exact public contracts and behavior:

```ts
import { setTimeout as delay } from "node:timers/promises";
import {
  type CredentialPort,
  CredentialRefreshError,
  type LocalizedText,
  type OAuthLoginContext,
  zod,
} from "@aio-proxy/plugin-sdk";
import type { XAIGrokCredential } from "./schema";

const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const REFRESH_WINDOW_MS = 300_000;

const discoverySchema = zod.object({
  device_authorization_endpoint: zod.string().min(1),
  token_endpoint: zod.string().min(1),
}).loose();
const deviceSchema = zod.object({
  device_code: zod.string().min(1),
  user_code: zod.string().min(1),
  verification_uri: zod.string().optional(),
  verification_uri_complete: zod.string().optional(),
  expires_in: zod.number().positive(),
  interval: zod.number().positive(),
}).loose();
const tokenSchema = zod.object({
  access_token: zod.string().optional(),
  refresh_token: zod.string().optional(),
  id_token: zod.string().optional(),
  expires_in: zod.number().optional(),
  error: zod.string().optional(),
  error_description: zod.string().optional(),
}).loose();

export type XAIGrokOAuthOptions = {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly deviceInstructions?: LocalizedText;
  readonly waitingForAuthorization?: LocalizedText;
  readonly signal?: AbortSignal;
};

class XAIOAuthHttpError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) { super(message); }
}

export function validateXAIEndpoint(value: string, field: string): string {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new Error(`Invalid xAI ${field}`); }
  const host = endpoint.hostname.toLowerCase();
  if (endpoint.protocol !== "https:" || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
    throw new Error(`Invalid xAI ${field}`);
  }
  return value;
}

export async function loginXAIGrok(context: OAuthLoginContext, options: XAIGrokOAuthOptions = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  const endpoints = await discover(fetcher, context.signal);
  const device = deviceSchema.parse(await postForm(fetcher, endpoints.device, {
    client_id: CLIENT_ID,
    scope: SCOPE,
  }, context.signal));
  const verification = device.verification_uri_complete ?? device.verification_uri;
  if (verification === undefined) throw new Error("xAI device response is missing verification URI");
  validateXAIEndpoint(verification, "verification_uri");
  await context.authorization.presentDeviceCode({
    url: verification,
    userCode: device.user_code,
    instructions: appendCode(options.deviceInstructions ?? "Enter code", device.user_code),
  });

  let interval = Math.max(device.interval, 5);
  const deadline = now() + device.expires_in * 1_000;
  while (now() <= deadline) {
    context.signal.throwIfAborted();
    const response = await postFormResponse(fetcher, endpoints.token, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: CLIENT_ID,
      device_code: device.device_code,
    }, context.signal);
    const body = tokenSchema.parse(await response.json());
    if (response.ok) return loginResult(body, now());
    if (body.error === "authorization_pending" || body.error === "slow_down") {
      if (body.error === "slow_down") interval += 5;
      context.progress(options.waitingForAuthorization ?? "Waiting for xAI authorization");
      await sleep(interval * 1_000, context.signal);
      continue;
    }
    throw new Error(`xAI device authorization failed: ${body.error ?? response.status}`);
  }
  throw new Error("xAI device authorization timed out");
}

export async function refreshXAIGrokCredential(
  credential: XAIGrokCredential,
  options: XAIGrokOAuthOptions = {},
): Promise<XAIGrokCredential> {
  const fetcher = options.fetch ?? globalThis.fetch;
  try {
    const signal = options.signal ?? new AbortController().signal;
    const endpoints = await discover(fetcher, signal);
    const response = await postFormResponse(fetcher, endpoints.token, {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: credential.refreshToken,
    }, signal);
    const body = tokenSchema.parse(await response.json());
    if (!response.ok) {
      const reason = body.error === "invalid_grant" ? "invalid_grant" : classifyStatus(response.status);
      throw refreshError(isRetryableStatus(response.status), reason, response.status);
    }
    const accessToken = body.access_token?.trim();
    if (!accessToken || body.expires_in === undefined || body.expires_in <= 0) {
      throw refreshError(false, "invalid_payload");
    }
    return {
      ...credential,
      accessToken,
      refreshToken: body.refresh_token?.trim() || credential.refreshToken,
      expiresAt: (options.now ?? Date.now)() + body.expires_in * 1_000,
    };
  } catch (error) {
    if (error instanceof CredentialRefreshError) throw error;
    if (error instanceof XAIOAuthHttpError) throw refreshError(error.retryable, "discovery_failed", error.status);
    throw refreshError(false, "invalid_payload");
  }
}

export async function currentXAIGrokCredential(
  port: CredentialPort<XAIGrokCredential>,
  options: XAIGrokOAuthOptions = {},
): Promise<XAIGrokCredential> {
  options.signal?.throwIfAborted();
  const current = await waitForCaller(port.read(), options.signal);
  if ((options.now ?? Date.now)() < current.value.expiresAt - REFRESH_WINDOW_MS) return current.value;
  const refreshed = port.refresh(current.revision, async ({ value }, signal) => {
    const next = await refreshXAIGrokCredential(value, { ...options, signal });
    return { value: next, metadata: { expiresAt: next.expiresAt } };
  });
  return (await waitForCaller(refreshed, options.signal)).snapshot.value;
}

async function discover(fetcher: typeof fetch, signal: AbortSignal) {
  const response = await request(fetcher, DISCOVERY_URL, { headers: { accept: "application/json" }, signal });
  if (!response.ok) throw new XAIOAuthHttpError("xAI discovery failed", isRetryableStatus(response.status), response.status);
  const body = discoverySchema.parse(await response.json());
  return {
    device: validateXAIEndpoint(body.device_authorization_endpoint, "device_authorization_endpoint"),
    token: validateXAIEndpoint(body.token_endpoint, "token_endpoint"),
  };
}

async function postForm(fetcher: typeof fetch, url: string, body: Record<string, string>, signal: AbortSignal) {
  const response = await postFormResponse(fetcher, url, body, signal);
  if (!response.ok) throw new XAIOAuthHttpError("xAI OAuth request failed", isRetryableStatus(response.status), response.status);
  return await response.json();
}

async function postFormResponse(fetcher: typeof fetch, url: string, body: Record<string, string>, signal: AbortSignal) {
  return await request(fetcher, url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal,
  });
}

async function request(fetcher: typeof fetch, input: string, init: RequestInit): Promise<Response> {
  try { return await fetcher(input, init); }
  catch {
    if (init.signal?.aborted) throw init.signal.reason;
    throw new XAIOAuthHttpError("xAI OAuth network request failed", true, undefined);
  }
}

function loginResult(body: zod.infer<typeof tokenSchema>, now: number) {
  const accessToken = body.access_token?.trim();
  const refreshToken = body.refresh_token?.trim();
  if (!accessToken || !refreshToken || body.expires_in === undefined || body.expires_in <= 0) {
    throw new Error("xAI token response is missing credentials or expiry");
  }
  const claims = readClaims(body.id_token ?? accessToken);
  const email = readClaim(claims, "email");
  const subject = readClaim(claims, "sub");
  const identity = subject === undefined
    ? email === undefined ? `refresh:${refreshToken}` : `email:${email.toLowerCase()}`
    : `sub:${subject}`;
  const digest = new Bun.CryptoHasher("sha256").update(identity).digest("hex");
  const expiresAt = now + body.expires_in * 1_000;
  const credentials = {
    accessToken,
    refreshToken,
    expiresAt,
    ...(email === undefined ? {} : { email }),
    ...(subject === undefined ? {} : { subject }),
  };
  return {
    fingerprint: `sha256:${digest}`,
    suggestedKey: `grok-${digest.slice(0, 12)}`,
    label: email ?? subject ?? "xAI Grok",
    credentials,
    expiresAt,
  };
}

function readClaims(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1];
    const value: unknown = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function readClaim(claims: Record<string, unknown>, key: string): string | undefined {
  const value = claims[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function appendCode(text: LocalizedText, code: string): LocalizedText {
  if (typeof text === "string") return `${text} ${code}`;
  return Object.fromEntries(Object.entries(text).map(([locale, value]) => [locale, `${value} ${code}`])) as LocalizedText;
}

function isRetryableStatus(status: number): boolean { return status === 408 || status === 429 || status >= 500; }
function classifyStatus(status: number): string { return status === 429 ? "rate_limited" : status >= 500 ? "upstream_5xx" : "request_rejected"; }
function refreshError(retryable: boolean, reason: string, status?: number) {
  return new CredentialRefreshError("xAI token refresh failed", { retryable, reason, ...(status === undefined ? {} : { status }) });
}

async function waitForCaller<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await operation;
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
```

- [x] **Step 4: Run the OAuth test and verify GREEN**

Run:

```bash
rtk bun test packages/plugins/xai-grok/src/oauth.test.ts
```

Expected: 6 tests pass with no warnings.

- [x] **Step 5: Commit the OAuth lifecycle**

```bash
rtk git add packages/plugins/xai-grok/package.json packages/plugins/xai-grok/tsconfig.json packages/plugins/xai-grok/rslib.config.ts packages/plugins/xai-grok/src/schema.ts packages/plugins/xai-grok/src/oauth.ts packages/plugins/xai-grok/src/oauth packages/plugins/xai-grok/src/oauth.test.ts bun.lock
rtk git commit -m "feat(xai-grok): add oauth credential lifecycle" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Dynamic catalog and CLI proxy runtime

**Files:**
- Create: `packages/plugins/xai-grok/src/catalog.ts`
- Test: `packages/plugins/xai-grok/src/catalog.test.ts`
- Create: `packages/plugins/xai-grok/src/runtime.ts`
- Test: `packages/plugins/xai-grok/src/runtime.test.ts`

**Interfaces:**
- Consumes: `currentXAIGrokCredential()` and `XAIGrokCredential` from Task 1.
- Produces: `discoverXAIGrokModels()`, `initialXAIGrokCatalogFallback()`, `createXAIGrokRuntime()`, and `createXAIGrokDynamicFetch()`.

- [ ] **Step 1: Write failing catalog tests**

Create `packages/plugins/xai-grok/src/catalog.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { CredentialPort } from "@aio-proxy/plugin-sdk";
import {
  discoverXAIGrokModels,
  initialXAIGrokCatalogFallback,
  XAIGrokCatalogError,
} from "./catalog";
import type { XAIGrokCredential } from "./schema";

describe("xAI Grok model catalog", () => {
  test("discovers account models and excludes non-chat surfaces", async () => {
    let request: Request | undefined;
    const catalog = await discoverXAIGrokModels(context(), {
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ data: [
          { id: "grok-4.5" },
          { id: "grok-new", name: "Grok New" },
          { id: "grok-imagine-image" },
          { id: "embedding-model" },
        ] });
      },
      now: () => 0,
    });
    expect(request?.url).toBe("https://api.x.ai/v1/models");
    expect(request?.headers.get("authorization")).toBe("Bearer access-token");
    expect(catalog.language).toEqual([
      { id: "grok-4.5", displayName: "Grok 4.5" },
      { id: "grok-new", displayName: "Grok New" },
    ]);
  });

  test("falls back only for retryable discovery failures", () => {
    expect(initialXAIGrokCatalogFallback(new XAIGrokCatalogError("network", true))?.language)
      .toContainEqual({ id: "grok-build", displayName: "Grok Build" });
    expect(initialXAIGrokCatalogFallback(new XAIGrokCatalogError("unauthorized", false))).toBeUndefined();
  });

  test("treats a successful empty catalog as authoritative", async () => {
    const catalog = await discoverXAIGrokModels(context(), { fetch: async () => Response.json({ data: [] }), now: () => 0 });
    expect(catalog.language).toEqual([]);
  });
});

function context() {
  return {
    credentials: staticPort(),
    options: {},
    signal: new AbortController().signal,
  };
}

function staticPort(): CredentialPort<XAIGrokCredential> {
  return {
    read: async () => ({ revision: 1, value: { accessToken: "access-token", refreshToken: "refresh", expiresAt: 600_000 } }),
    refresh: async () => { throw new Error("fresh credential must not refresh"); },
  };
}
```

- [ ] **Step 2: Run catalog tests and verify RED**

Run: `rtk bun test packages/plugins/xai-grok/src/catalog.test.ts`

Expected: FAIL because `./catalog` does not exist.

- [ ] **Step 3: Implement catalog discovery and curated fallback**

Create `packages/plugins/xai-grok/src/catalog.ts`:

```ts
import type { AccountContext, ModelCatalog } from "@aio-proxy/plugin-sdk";
import { currentXAIGrokCredential, type XAIGrokOAuthOptions } from "./oauth";
import type { XAIGrokCredential } from "./schema";

export const XAI_GROK_CATALOG_TTL_MS = 6 * 60 * 60_000;
const MODELS_URL = "https://api.x.ai/v1/models";
const NON_CHAT_PREFIXES = ["grok-imagine-", "grok-stt-", "grok-voice-"] as const;
const CURATED = [
  ["grok-build", "Grok Build"],
  ["grok-build-0.1", "Grok Build 0.1"],
  ["grok-4.3", "Grok 4.3"],
  ["grok-4.5", "Grok 4.5"],
  ["grok-4.20-multi-agent-0309", "Grok 4.20 (Multi-Agent)"],
  ["grok-4.20-0309-reasoning", "Grok 4.20 (Reasoning)"],
  ["grok-4.20-0309-non-reasoning", "Grok 4.20 (Non-Reasoning)"],
  ["grok-composer-2.5-fast", "Grok Composer 2.5 Fast"],
] as const;
const curatedNames = new Map<string, string>(CURATED);

export class XAIGrokCatalogError extends Error {
  override readonly name = "XAIGrokCatalogError";
  constructor(message: string, readonly retryable: boolean, readonly status?: number) { super(message); }
}

export async function discoverXAIGrokModels(
  context: AccountContext<XAIGrokCredential, Record<string, never>>,
  options: XAIGrokOAuthOptions = {},
): Promise<ModelCatalog> {
  const credential = await currentXAIGrokCredential(context.credentials, { ...options, signal: context.signal });
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(MODELS_URL, {
      headers: { accept: "application/json", authorization: `Bearer ${credential.accessToken}` },
      signal: context.signal,
    });
  } catch { throw new XAIGrokCatalogError("xAI model discovery network failure", true); }
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  if (!response.ok) throw new XAIGrokCatalogError("xAI model discovery rejected", retryable, response.status);

  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new XAIGrokCatalogError("xAI model discovery returned invalid JSON", true); }
  if (typeof payload !== "object" || payload === null || !Array.isArray(Reflect.get(payload, "data"))) {
    throw new XAIGrokCatalogError("xAI model discovery returned invalid data", true);
  }
  const byId = new Map<string, { id: string; displayName?: string }>();
  for (const value of Reflect.get(payload, "data") as unknown[]) {
    if (typeof value !== "object" || value === null) continue;
    const id = Reflect.get(value, "id");
    if (typeof id !== "string" || !id.startsWith("grok-") || NON_CHAT_PREFIXES.some((prefix) => id.startsWith(prefix))) continue;
    const name = Reflect.get(value, "name");
    const displayName = curatedNames.get(id) ?? (typeof name === "string" && name.trim() !== "" ? name.trim() : undefined);
    byId.set(id, { id, ...(displayName === undefined ? {} : { displayName }) });
  }
  return emptyCatalog([...byId.values()].sort((left, right) => left.id.localeCompare(right.id)));
}

export function initialXAIGrokCatalogFallback(error: unknown): ModelCatalog | undefined {
  return error instanceof XAIGrokCatalogError && error.retryable
    ? emptyCatalog(CURATED.map(([id, displayName]) => ({ id, displayName })))
    : undefined;
}

function emptyCatalog(language: ModelCatalog["language"]): ModelCatalog {
  return { language, image: [], embedding: [], speech: [], transcription: [], reranking: [] };
}
```

- [ ] **Step 4: Run catalog tests and verify GREEN**

Run: `rtk bun test packages/plugins/xai-grok/src/catalog.test.ts`

Expected: 3 tests pass.

- [ ] **Step 5: Write failing CLI proxy runtime tests**

Create `packages/plugins/xai-grok/src/runtime.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { CredentialPort } from "@aio-proxy/plugin-sdk";
import { createXAIGrokDynamicFetch, createXAIGrokRuntime } from "./runtime";
import type { XAIGrokCredential } from "./schema";

describe("xAI Grok runtime", () => {
  test("exposes Responses language models without raw capability", async () => {
    const runtime = await createXAIGrokRuntime({ credentials: port(), options: {}, catalog: emptyCatalog() });
    expect(runtime.provider.specificationVersion).toBe("v4");
    expect(runtime.provider.languageModel("grok-4.5").modelId).toBe("grok-4.5");
    expect(runtime.raw).toBeUndefined();
  });

  test("injects CLI identity and removes only reasoning.summary", async () => {
    let captured: Request | undefined;
    let observedSignal: AbortSignal | null | undefined;
    const controller = new AbortController();
    const dynamicFetch = createXAIGrokDynamicFetch(port(), {
      fetch: async (input, init) => {
        captured = new Request(input, init);
        observedSignal = init?.signal;
        return new Response(null, { status: 200 });
      },
      now: () => 0,
    });
    await dynamicFetch("https://cli-chat-proxy.grok.com/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer placeholder", "x-keep": "yes" },
      body: JSON.stringify({ model: "grok-4.5", reasoning: { effort: "high", summary: "auto" } }),
      signal: controller.signal,
    });
    expect(captured?.url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(captured?.headers.get("authorization")).toBe("Bearer access-token");
    expect(captured?.headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(captured?.headers.get("x-grok-client-version")).toBe("0.2.93");
    expect(captured?.headers.get("user-agent")).toBe("xai-grok-workspace/0.2.93");
    expect(captured?.headers.get("x-keep")).toBe("yes");
    expect(await captured?.json()).toEqual({ model: "grok-4.5", reasoning: { effort: "high" } });
    expect(observedSignal).toBe(controller.signal);
  });
});

function port(): CredentialPort<XAIGrokCredential> {
  return {
    read: async () => ({ revision: 1, value: { accessToken: "access-token", refreshToken: "refresh", expiresAt: 600_000 } }),
    refresh: async () => { throw new Error("fresh credential must not refresh"); },
  };
}

function emptyCatalog() {
  return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
}
```

- [ ] **Step 6: Run runtime tests and verify RED**

Run: `rtk bun test packages/plugins/xai-grok/src/runtime.test.ts`

Expected: FAIL because `./runtime` does not exist.

- [ ] **Step 7: Implement the minimal Responses runtime**

Create `packages/plugins/xai-grok/src/runtime.ts`:

```ts
import { createOpenAI } from "@ai-sdk/openai";
import type { CredentialPort, OAuthRuntimeResult, RuntimeContext } from "@aio-proxy/plugin-sdk";
import { currentXAIGrokCredential, type XAIGrokOAuthOptions } from "./oauth";
import type { XAIGrokCredential } from "./schema";

const BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const CLIENT_VERSION = "0.2.93";

export async function createXAIGrokRuntime(
  context: RuntimeContext<XAIGrokCredential, Record<string, never>>,
  options: XAIGrokOAuthOptions = {},
): Promise<OAuthRuntimeResult> {
  const provider = createOpenAI({
    name: "xai-grok-oauth",
    baseURL: BASE_URL,
    apiKey: "dynamic-credential",
    fetch: createXAIGrokDynamicFetch(context.credentials, options),
  });
  return {
    provider: {
      specificationVersion: "v4",
      languageModel: (modelId) => provider.responses(modelId),
      embeddingModel: () => { throw new Error("xAI Grok OAuth does not support embedding"); },
      imageModel: () => { throw new Error("xAI Grok OAuth does not support image generation"); },
    },
  };
}

export function createXAIGrokDynamicFetch(
  credentials: CredentialPort<XAIGrokCredential>,
  options: XAIGrokOAuthOptions = {},
): typeof fetch {
  return async (input, init) => {
    const credential = await currentXAIGrokCredential(credentials, { ...options, signal: init?.signal ?? options.signal });
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${credential.accessToken}`);
    headers.set("X-XAI-Token-Auth", "xai-grok-cli");
    headers.set("x-grok-client-version", CLIENT_VERSION);
    headers.set("User-Agent", `xai-grok-workspace/${CLIENT_VERSION}`);
    headers.delete("content-length");
    const body = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : patchResponsesBody(request.url, await request.text());
    return await (options.fetch ?? globalThis.fetch)(request.url, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: init?.signal ?? (input instanceof Request ? input.signal : request.signal),
      redirect: request.redirect,
    });
  };
}

function patchResponsesBody(url: string, body: string): string {
  if (!new URL(url).pathname.endsWith("/responses")) return body;
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value !== "object" || value === null) return body;
    const reasoning = Reflect.get(value, "reasoning");
    if (typeof reasoning !== "object" || reasoning === null || !Reflect.has(reasoning, "summary")) return body;
    Reflect.deleteProperty(reasoning, "summary");
    return JSON.stringify(value);
  } catch { return body; }
}
```

- [ ] **Step 8: Run catalog and runtime tests and verify GREEN**

Run:

```bash
rtk bun test packages/plugins/xai-grok/src/catalog.test.ts packages/plugins/xai-grok/src/runtime.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 9: Commit catalog and runtime**

```bash
rtk git add packages/plugins/xai-grok/src/catalog.ts packages/plugins/xai-grok/src/catalog.test.ts packages/plugins/xai-grok/src/runtime.ts packages/plugins/xai-grok/src/runtime.test.ts
rtk git commit -m "feat(xai-grok): add catalog and cli runtime" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Read-only Grok credits quota

**Files:**
- Create: `packages/plugins/xai-grok/src/quota-protobuf.ts`
- Test: `packages/plugins/xai-grok/src/quota-protobuf.test.ts`
- Create: `packages/plugins/xai-grok/src/quota.ts`
- Test: `packages/plugins/xai-grok/src/quota.test.ts`

**Interfaces:**
- Consumes: `currentXAIGrokCredential()`, `XAIGrokOAuthOptions`, `XAIGrokCredential`, and the existing `AccountContext`/`OAuthQuotaSnapshot` SDK types.
- Produces: `parseXAIGrokBilling(data, now)`, `validateXAIGrokGrpcStatus(headers)`, and `readXAIGrokQuota(context, options)`.

- [ ] **Step 1: Write failing gRPC-Web and protobuf parser tests**

Create `packages/plugins/xai-grok/src/quota-protobuf.test.ts`:

```ts
import { expect, test } from "bun:test";
import { parseXAIGrokBilling, validateXAIGrokGrpcStatus } from "./quota-protobuf";

test("parses framed and unframed Grok billing payloads", () => {
  const payload = billingPayload(42.5, 1_800_000_000);
  const now = 1_799_000_000_000;
  expect(parseXAIGrokBilling(frame(payload), now)).toEqual({ usedPercent: 42.5, resetsAt: 1_800_000_000_000 });
  expect(parseXAIGrokBilling(payload, now)).toEqual({ usedPercent: 42.5, resetsAt: 1_800_000_000_000 });
});

test("accepts omitted zero usage only when a current usage period exists", () => {
  const payload = Uint8Array.from([
    0x0a, 0x18, 0x2a, 0x06, 0x08, 0x80, 0xb1, 0x91, 0xd2, 0x06,
    0x42, 0x0e, 0x08, 0x01, 0x12, 0x06, 0x08, 0x80, 0x97, 0xf3, 0xd0, 0x06,
    0x1a, 0x02, 0x08, 0x01,
  ]);
  expect(parseXAIGrokBilling(payload, 1_781_000_000_000)).toEqual({
    usedPercent: 0,
    resetsAt: 1_782_864_000_000,
  });
  expect(() => parseXAIGrokBilling(Uint8Array.from([0x10, ...varint(1_800_000_000)]), 0)).toThrow(
    "Could not parse xAI Grok billing usage",
  );
});

test("rejects nonzero grpc status from headers or trailer frames", () => {
  expect(() => validateXAIGrokGrpcStatus(new Headers({ "grpc-status": "16" }))).toThrow("RPC failed");
  const trailer = frame(new TextEncoder().encode("grpc-status: 7\r\n"), 0x80);
  expect(() => parseXAIGrokBilling(trailer, 0)).toThrow("RPC failed");
});

function billingPayload(usedPercent: number, resetEpoch: number): Uint8Array {
  const bytes = new Uint8Array(5 + varint(resetEpoch).length);
  bytes[0] = 0x0d;
  new DataView(bytes.buffer).setFloat32(1, usedPercent, true);
  bytes[5] = 0x10;
  bytes.set(varint(resetEpoch), 6);
  return bytes;
}

function frame(payload: Uint8Array, flags = 0): Uint8Array {
  const bytes = new Uint8Array(payload.length + 5);
  bytes[0] = flags;
  new DataView(bytes.buffer).setUint32(1, payload.length);
  bytes.set(payload, 5);
  return bytes;
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  let current = BigInt(value);
  while (current >= 0x80n) { bytes.push(Number(current & 0x7fn) | 0x80); current >>= 7n; }
  bytes.push(Number(current));
  return bytes;
}
```

- [ ] **Step 2: Run parser tests and verify RED**

Run: `rtk bun test packages/plugins/xai-grok/src/quota-protobuf.test.ts`

Expected: FAIL because `./quota-protobuf` does not exist.

- [ ] **Step 3: Implement the bounded gRPC-Web/protobuf parser**

Create `packages/plugins/xai-grok/src/quota-protobuf.ts` with these exact contracts:

```ts
export type XAIGrokBillingSnapshot = { readonly usedPercent: number; readonly resetsAt?: number };

export function validateXAIGrokGrpcStatus(headers: Headers): void;
export function parseXAIGrokBilling(data: Uint8Array, now?: number): XAIGrokBillingSnapshot;
```

Implementation requirements:

```ts
const MIN_EPOCH_SECONDS = 1_700_000_000n;
const MAX_EPOCH_SECONDS = 2_100_000_000n;
const MAX_DEPTH = 4;

// 1. Parse exact 5-byte gRPC-Web frame headers. Data frames have flags & 0x80 == 0;
//    trailer frames are UTF-8 header lines. Invalid framing falls back to raw protobuf
//    only when the first protobuf key has wire type 0, 1, 2, or 5.
// 2. Decode grpc-status from HTTP Headers and trailer fields. Status 0 or absence succeeds;
//    any other integer throws new Error("xAI Grok billing RPC failed").
// 3. Recursively scan length-delimited fields to depth 4. Decode varints as bigint and
//    fixed32 values with DataView#getFloat32(offset, true). Invalid segments advance one
//    byte so an unrelated nested scalar does not abort the whole scan.
// 4. Choose an in-range fixed32 whose path ends in field 1, preferring the shortest path
//    and then earliest wire order. Choose future Unix seconds, preferring [1, 5, 1], then
//    the earliest future timestamp. Convert the selected timestamp to milliseconds.
// 5. When no fixed32 exists, return 0 only if a reset exists and a varint path begins [1, 6]
//    or equals [1, 8, 1] with value 1 or 2. Otherwise throw
//    new Error("Could not parse xAI Grok billing usage").
```

Do not add a protobuf dependency and do not include payload or trailer text in thrown errors.

- [ ] **Step 4: Run parser tests and verify GREEN**

Run: `rtk bun test packages/plugins/xai-grok/src/quota-protobuf.test.ts`

Expected: 3 tests pass.

- [ ] **Step 5: Write the failing authenticated quota-read test**

Create `packages/plugins/xai-grok/src/quota.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { CredentialPort } from "@aio-proxy/plugin-sdk";
import { readXAIGrokQuota } from "./quota";
import type { XAIGrokCredential } from "./schema";

test("reads Grok credits with OAuth and maps used percent to remaining ratio", async () => {
  let request: Request | undefined;
  const snapshot = await readXAIGrokQuota({
    credentials: port(), options: {}, signal: new AbortController().signal,
  }, {
    now: () => 1_799_000_000_000,
    fetch: async (input, init) => {
      request = new Request(input, init);
      return new Response(frame(billingPayload(25, 1_800_000_000)), {
        status: 200,
        headers: { "content-type": "application/grpc-web+proto", "grpc-status": "0" },
      });
    },
  });

  expect(request?.url).toBe("https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig");
  expect(request?.method).toBe("POST");
  expect(request?.headers.get("authorization")).toBe("Bearer access-token");
  expect(request?.headers.get("origin")).toBe("https://grok.com");
  expect(request?.headers.get("referer")).toBe("https://grok.com/?_s=usage");
  expect(request?.headers.get("content-type")).toBe("application/grpc-web+proto");
  expect(request?.headers.get("x-grpc-web")).toBe("1");
  expect(request?.headers.get("x-user-agent")).toBe("connect-es/2.1.1");
  if (request === undefined) throw new Error("quota request was not captured");
  expect(new Uint8Array(await request.arrayBuffer())).toEqual(Uint8Array.of(0, 0, 0, 0, 0));
  expect(snapshot).toEqual({ items: [{
    id: "credits",
    label: { default: "Credits", "zh-Hans": "额度" },
    remainingRatio: 0.75,
    resetsAt: 1_800_000_000_000,
  }] });
  expect("resetCredits" in snapshot).toBeFalse();
});

function port(): CredentialPort<XAIGrokCredential> {
  return {
    read: async () => ({ revision: 1, value: {
      accessToken: "access-token", refreshToken: "refresh", expiresAt: 1_800_000_000_000,
    } }),
    refresh: async () => { throw new Error("fresh credential must not refresh"); },
  };
}

function billingPayload(usedPercent: number, resetEpoch: number): Uint8Array {
  const encodedReset = varint(resetEpoch);
  const bytes = new Uint8Array(6 + encodedReset.length);
  bytes[0] = 0x0d;
  new DataView(bytes.buffer).setFloat32(1, usedPercent, true);
  bytes[5] = 0x10;
  bytes.set(encodedReset, 6);
  return bytes;
}

function frame(payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(payload.length + 5);
  new DataView(bytes.buffer).setUint32(1, payload.length);
  bytes.set(payload, 5);
  return bytes;
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  let current = BigInt(value);
  while (current >= 0x80n) { bytes.push(Number(current & 0x7fn) | 0x80); current >>= 7n; }
  bytes.push(Number(current));
  return bytes;
}
```

- [ ] **Step 6: Run quota test and verify RED**

Run: `rtk bun test packages/plugins/xai-grok/src/quota.test.ts`

Expected: FAIL because `./quota` does not exist.

- [ ] **Step 7: Implement the authenticated read-only quota capability**

Create `packages/plugins/xai-grok/src/quota.ts`:

```ts
import type { AccountContext, OAuthQuotaSnapshot } from "@aio-proxy/plugin-sdk";
import { currentXAIGrokCredential, type XAIGrokOAuthOptions } from "./oauth";
import { parseXAIGrokBilling, validateXAIGrokGrpcStatus } from "./quota-protobuf";
import type { XAIGrokCredential } from "./schema";

const BILLING_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";

export async function readXAIGrokQuota(
  context: AccountContext<XAIGrokCredential, Record<string, never>>,
  options: XAIGrokOAuthOptions = {},
): Promise<OAuthQuotaSnapshot> {
  const credential = await currentXAIGrokCredential(context.credentials, { ...options, signal: context.signal });
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(BILLING_URL, {
      method: "POST",
      headers: {
        accept: "*/*",
        authorization: `Bearer ${credential.accessToken}`,
        "content-type": "application/grpc-web+proto",
        origin: "https://grok.com",
        referer: "https://grok.com/?_s=usage",
        "user-agent": "aio-proxy",
        "x-grpc-web": "1",
        "x-user-agent": "connect-es/2.1.1",
      },
      body: Uint8Array.of(0, 0, 0, 0, 0),
      signal: context.signal,
    });
  } catch {
    if (context.signal.aborted) throw context.signal.reason;
    throw new Error("xAI Grok billing request failed");
  }
  if (!response.ok) throw new Error(`xAI Grok billing request failed (${response.status})`);
  validateXAIGrokGrpcStatus(response.headers);
  const billing = parseXAIGrokBilling(new Uint8Array(await response.arrayBuffer()), options.now?.());
  return {
    items: [{
      id: "credits",
      label: { default: "Credits", "zh-Hans": "额度" },
      remainingRatio: Math.max(0, Math.min(1, 1 - billing.usedPercent / 100)),
      ...(billing.resetsAt === undefined ? {} : { resetsAt: billing.resetsAt }),
    }],
  };
}
```

- [ ] **Step 8: Run quota tests and verify GREEN**

Run:

```bash
rtk bun test packages/plugins/xai-grok/src/quota-protobuf.test.ts packages/plugins/xai-grok/src/quota.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 9: Commit the quota reader**

```bash
rtk git add packages/plugins/xai-grok/src/quota-protobuf.ts packages/plugins/xai-grok/src/quota-protobuf.test.ts packages/plugins/xai-grok/src/quota.ts packages/plugins/xai-grok/src/quota.test.ts
rtk git commit -m "feat(xai-grok): add credits quota reader" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Plugin descriptor, built-in registration, and verification

**Files:**
- Create: `packages/plugins/xai-grok/src/plugin.ts`
- Create: `packages/plugins/xai-grok/src/index.ts`
- Test: `packages/plugins/xai-grok/src/plugin.test.ts`
- Create: `packages/plugins/xai-grok/oauth.smoke.ts`
- Modify: `packages/core/src/plugins/builtins.ts:1-70`
- Modify: `packages/core/src/plugins/builtins.test.ts:1-80`
- Modify: `packages/core/package.json:32-40`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: Task 1 login/credential APIs, Task 2 catalog/runtime APIs, and Task 3 quota reader.
- Produces: default `PluginDescriptor`, `createXAIGrokPlugin()`, localized presentation injection, package version, read-only quota registration, and core built-in identity.

- [ ] **Step 1: Write the failing descriptor test**

Create `packages/plugins/xai-grok/src/plugin.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { OAuthAdapter, PluginDescriptor } from "@aio-proxy/plugin-sdk";
import packageJson from "../package.json" with { type: "json" };
import xaiGrokPlugin, { createXAIGrokPlugin, XAI_GROK_PLUGIN_VERSION } from ".";

test("exports a versioned xAI Grok OAuth descriptor", async () => {
  const adapter = await adapterFrom(xaiGrokPlugin);
  expect(adapter.id).toBe("default");
  expect(adapter.label).toBe("Login with xAI Grok");
  expect(adapter.icon).toBe("xai");
  expect(adapter.account.options.form).toEqual([]);
  expect(adapter.catalog.policy).toEqual({ kind: "ttl", ttlMs: 6 * 60 * 60_000 });
  expect(adapter.quota?.reset).toBeUndefined();
  expect(XAI_GROK_PLUGIN_VERSION).toBe(packageJson.version);
});

test("accepts localized copy without adding account options", async () => {
  const adapter = await adapterFrom(createXAIGrokPlugin({
    pluginLabel: "xAI Grok",
    pluginDescription: "Compte Grok",
    adapterLabel: "Connexion Grok",
    deviceInstructions: "Saisissez le code",
    waitingForAuthorization: "Autorisation xAI en attente",
  }));
  expect(adapter.label).toBe("Connexion Grok");
  await expect(adapter.account.options.schema.parseAsync({})).resolves.toEqual({});
});

async function adapterFrom(descriptor: PluginDescriptor): Promise<OAuthAdapter<Record<string, never>, unknown>> {
  let adapter: OAuthAdapter<Record<string, never>, unknown> | undefined;
  await descriptor.setup({ oauth: { register: (value) => { adapter = value as never; } } }, undefined);
  if (adapter === undefined) throw new Error("plugin did not register OAuth adapter");
  return adapter;
}
```

- [ ] **Step 2: Run descriptor test and verify RED**

Run: `rtk bun test packages/plugins/xai-grok/src/plugin.test.ts`

Expected: FAIL because `src/index.ts` does not exist.

- [ ] **Step 3: Implement descriptor and package exports**

Create `packages/plugins/xai-grok/src/plugin.ts`:

```ts
import {
  type ConfigSpec,
  definePlugin,
  type LocalizedText,
  type OAuthAdapter,
  type PluginDescriptor,
  zod,
} from "@aio-proxy/plugin-sdk";
import { discoverXAIGrokModels, initialXAIGrokCatalogFallback, XAI_GROK_CATALOG_TTL_MS } from "./catalog";
import { loginXAIGrok, type XAIGrokOAuthOptions } from "./oauth";
import { readXAIGrokQuota } from "./quota";
import { createXAIGrokRuntime } from "./runtime";
import { credentialSchema, type XAIGrokCredential } from "./schema";

export type XAIGrokPresentationText = {
  readonly pluginLabel?: LocalizedText;
  readonly pluginDescription?: LocalizedText;
  readonly adapterLabel: LocalizedText;
  readonly deviceInstructions: LocalizedText;
  readonly waitingForAuthorization: LocalizedText;
};

export const englishPresentationText: XAIGrokPresentationText = {
  pluginLabel: "xAI Grok",
  pluginDescription: "Use a SuperGrok or X Premium+ account to access Grok models",
  adapterLabel: "Login with xAI Grok",
  deviceInstructions: "Enter code",
  waitingForAuthorization: "Waiting for xAI authorization",
};

export function createXAIGrokPlugin(
  presentationText: XAIGrokPresentationText = englishPresentationText,
  dependencies: Pick<XAIGrokOAuthOptions, "fetch" | "now" | "sleep"> = {},
): PluginDescriptor<undefined> {
  const accountOptions = { schema: zod.object({}), form: [] } as const satisfies ConfigSpec<Record<string, never>>;
  const adapter: OAuthAdapter<Record<string, never>, XAIGrokCredential> = {
    id: "default",
    label: presentationText.adapterLabel,
    icon: "xai",
    account: { options: accountOptions },
    credentials: credentialSchema,
    login: async (context, options) => {
      await accountOptions.schema.parseAsync(options);
      return await loginXAIGrok(context, {
        ...dependencies,
        deviceInstructions: presentationText.deviceInstructions,
        waitingForAuthorization: presentationText.waitingForAuthorization,
      });
    },
    catalog: {
      policy: { kind: "ttl", ttlMs: XAI_GROK_CATALOG_TTL_MS },
      discover: (context) => discoverXAIGrokModels(context, dependencies),
      initialFallback: initialXAIGrokCatalogFallback,
    },
    quota: {
      read: (context) => readXAIGrokQuota(context, dependencies),
    },
    createRuntime: (context) => createXAIGrokRuntime(context, dependencies),
  };
  return definePlugin((api) => { api.oauth.register(adapter); }, {
    label: presentationText.pluginLabel ?? "xAI Grok",
    description: presentationText.pluginDescription ?? "Use a SuperGrok or X Premium+ account to access Grok models",
  });
}
```

Create `packages/plugins/xai-grok/src/index.ts`:

```ts
import packageJson from "../package.json" with { type: "json" };
import { createXAIGrokPlugin, englishPresentationText } from "./plugin";

export * from "./catalog";
export * from "./oauth";
export { createXAIGrokPlugin, englishPresentationText, type XAIGrokPresentationText } from "./plugin";
export * from "./quota";
export * from "./quota-protobuf";
export * from "./runtime";
export * from "./schema";

export const XAI_GROK_PLUGIN_VERSION = packageJson.version;
export default createXAIGrokPlugin(englishPresentationText);
```

Create `packages/plugins/xai-grok/oauth.smoke.ts`:

```ts
import { expect, test } from "bun:test";
import plugin, { XAI_GROK_PLUGIN_VERSION } from "./dist/index.js";

test("built artifact exports the xAI Grok descriptor", () => {
  expect(plugin.apiVersion).toBe(1);
  expect(XAI_GROK_PLUGIN_VERSION).toBe("0.0.0");
});
```

- [ ] **Step 4: Run plugin unit tests and verify GREEN**

Run:

```bash
rtk bun test packages/plugins/xai-grok/src
```

Expected: all xAI Grok colocated tests pass.

- [ ] **Step 5: Add the failing core built-in expectations**

In `packages/core/src/plugins/builtins.test.ts`, append `"@aio-proxy/plugin-xai-grok"` to `expectedBuiltIns`, change the built-in arrays from three values to four values, assert `resolveOAuth("@aio-proxy/plugin-xai-grok", "default")`, and add these localized assertions to the copy test:

```ts
const grok = snapshot.registry.resolveOAuth("@aio-proxy/plugin-xai-grok", "default");
const grokPlugin = snapshot.plugins.get("@aio-proxy/plugin-xai-grok");
expect(resolveLocalizedText(grokPlugin?.label ?? "", "zh-Hans")).toBe("xAI Grok");
expect(resolveLocalizedText(grokPlugin?.description ?? "", "zh-Hans")).toBe(
  "使用 SuperGrok 或 X Premium+ 账号访问 Grok 模型",
);
expect(resolveLocalizedText(grok?.label ?? "", "zh-Hans")).toBe("使用 xAI Grok 登录");
```

Run: `rtk bun test packages/core/src/plugins/builtins.test.ts`

Expected: FAIL because core has not embedded the new package.

- [ ] **Step 6: Register the built-in and workspace dependency**

Add this import to `packages/core/src/plugins/builtins.ts`:

```ts
import { createXAIGrokPlugin, XAI_GROK_PLUGIN_VERSION } from "@aio-proxy/plugin-xai-grok";
```

Append `"@aio-proxy/plugin-xai-grok"` to `BUILT_IN_PLUGIN_PACKAGE_NAMES` and append this entry to `createEmbeddedBuiltIns()`:

```ts
{
  packageName: "@aio-proxy/plugin-xai-grok",
  version: XAI_GROK_PLUGIN_VERSION,
  descriptor: createXAIGrokPlugin({
    pluginLabel: "xAI Grok",
    pluginDescription: localized(
      "Use a SuperGrok or X Premium+ account to access Grok models",
      "使用 SuperGrok 或 X Premium+ 账号访问 Grok 模型",
    ),
    adapterLabel: localized("Login with xAI Grok", "使用 xAI Grok 登录"),
    deviceInstructions: localized("Enter code", "输入代码"),
    waitingForAuthorization: localized("Waiting for xAI authorization", "正在等待 xAI 授权"),
  }) as unknown as PluginDescriptor<unknown>,
},
```

Add this dependency in alphabetical position under `packages/core/package.json` dependencies:

```json
"@aio-proxy/plugin-xai-grok": "workspace:*"
```

Refresh workspace links and lockfile:

```bash
rtk bun install
```

- [ ] **Step 7: Format only the changed package and built-in files**

Run:

```bash
rtk bunx biome check --write packages/plugins/xai-grok packages/core/src/plugins/builtins.ts packages/core/src/plugins/builtins.test.ts packages/core/package.json
```

Expected: Biome reports no remaining diagnostics in the changed files.

- [ ] **Step 8: Run focused plugin and built-in verification**

Run:

```bash
rtk bun test packages/plugins/xai-grok/src packages/core/src/plugins/builtins.test.ts
rtk bun run --cwd packages/plugins/xai-grok build
rtk bun run --cwd packages/plugins/xai-grok test:artifact
```

Expected: unit tests pass, build succeeds, artifact smoke test passes.

- [ ] **Step 9: Run repository preflight**

Run:

```bash
rtk bun run preflight
```

Expected: Biome check and all unit tests pass with no warnings or errors.

- [ ] **Step 10: Commit the built-in plugin**

```bash
rtk git add packages/plugins/xai-grok packages/core/src/plugins/builtins.ts packages/core/src/plugins/builtins.test.ts packages/core/package.json bun.lock
rtk git commit -m "feat(xai-grok): add built-in oauth provider" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Completion Check

- `rtk git status --short` shows only the user's pre-existing `.reference` entry.
- `rtk git log -5 --oneline` shows the design commit plus the four implementation commits.
- No source or test file exceeds 300 lines: `rtk wc -l packages/plugins/xai-grok/src/*.ts`.
- No production route, pipeline, plugin SDK, GitHub Copilot, or ChatGPT source changed.
