# Kimi Code OAuth Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in Kimi Code OAuth provider with device login, token refresh, dynamic model discovery, OpenAI/Anthropic routing, same-protocol raw transport, and read-only quota windows.

**Architecture:** A new `@aio-proxy/plugin-kimi-code` package owns every Kimi-specific concern behind the existing `OAuthAdapter`. OAuth, catalog, quota, and runtime share one credential refresh helper and one identity-header builder; core only embeds the descriptor and keeps protocol routing provider-agnostic.

**Tech Stack:** Bun 1.3.14, TypeScript 6, `@aio-proxy/plugin-sdk`, AI SDK v7, `@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`, Rslib, Bun test.

## Global Constraints

- Kimi Code platform endpoints use `https://auth.kimi.com` and `https://api.kimi.com/coding`; do not use Moonshot Open Platform endpoints.
- Use Provider ID and Provider weight terminology from `AGENTS.md`.
- Reuse the existing OAuth plugin SDK, credential CAS, catalog cache, candidate loop, and AI SDK dependencies; add no new runtime dependency or host abstraction.
- Quota is read-only `GET /coding/v1/usages`; do not call `www.kimi.com`, implement quota reset, or return reset credits.
- Do not copy CPA tool-message/reasoning/model-name compatibility patches without an aio-proxy regression.
- Every handwritten source and test file stays below 300 lines; tests are colocated with source.
- Write each behavior test first, run it to observe the expected failure, then add only enough production code to pass.
- Final verification is `bun run preflight`.

---

## File Structure

Create `packages/plugins/kimi-code/` with these responsibilities:

- `src/headers.ts`: printable-ASCII Kimi identity headers.
- `src/oauth.ts`: device login, token parsing, refresh, and `CredentialPort` refresh policy.
- `src/catalog.ts`: authenticated model discovery and first-login fallback.
- `src/quota.ts`: authenticated read-only usage-window mapping.
- `src/runtime.ts`: AI SDK provider selection and safe raw URL rewriting.
- `src/plugin.ts`: adapter assembly, localized presentation injection, and dependency wiring.
- `src/index.ts`: package exports and default descriptor.
- Colocated `*.test.ts` files protect each public behavior.
- `test/setup.ts`, `rslib.config.ts`, and `oauth.smoke.ts` inject and verify the public OAuth client ID without leaving it in source text.

Modify host files only where the built-in identity is enumerated:

- `packages/core/src/plugins/builtins.ts`
- `packages/core/src/plugins/builtins.test.ts`
- `packages/core/package.json`
- `packages/cli/src/plugin-commands/plugin/add.test.ts`
- `packages/cli/src/plugin-commands/provider-login/capability.test.ts`
- `packages/cli/_test/binary-build.test.ts`
- `bun.lock`

---

### Task 1: Package shell and shared Kimi identity headers

**Files:**
- Create: `packages/plugins/kimi-code/package.json`
- Create: `packages/plugins/kimi-code/tsconfig.json`
- Create: `packages/plugins/kimi-code/rslib.config.ts`
- Create: `packages/plugins/kimi-code/test/setup.ts`
- Create: `packages/plugins/kimi-code/src/headers.test.ts`
- Create: `packages/plugins/kimi-code/src/headers.ts`
- Modify: `bun.lock`

**Interfaces:**
- Produces: `kimiIdentityHeaders(deviceId: string): Readonly<Record<string, string>>`
- Produces: build global `__AIO_PROXY_KIMI_CLIENT_ID__`

- [ ] **Step 1: Create the package metadata and build-time client ID injection**

Use the existing built-in package shape:

```json
{
  "name": "@aio-proxy/plugin-kimi-code",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "files": ["dist"],
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "rslib",
    "test": "bun run test:unit",
    "test:unit": "bun test --preload=./test/setup.ts",
    "test:artifact": "bun test ./oauth.smoke.ts"
  },
  "dependencies": {
    "@aio-proxy/plugin-sdk": "workspace:*",
    "@ai-sdk/anthropic": "catalog:",
    "@ai-sdk/openai-compatible": "catalog:"
  },
  "devDependencies": {
    "@aio-proxy/infra": "workspace:*",
    "@rslib/core": "catalog:",
    "@types/bun": "catalog:",
    "typescript": "catalog:"
  }
}
```

```ts
// rslib.config.ts
import { defineLibraryConfig } from "@aio-proxy/infra/rslib";

const decode = (...parts: string[]) => atob(parts.join(""));
export const kimiClientId = decode("MTdlNWY2NzEtZDE5NC00ZGZi", "LTk3MDYtNTUxNmNiNDhjMDk4");

export default defineLibraryConfig({
  source: { define: { __AIO_PROXY_KIMI_CLIENT_ID__: JSON.stringify(kimiClientId) } },
});
```

`tsconfig.json` extends `@aio-proxy/infra/tsconfig/base.json`, uses `src`/`dist`, includes `src/**/*.ts`, and excludes `src/**/*.test.ts`. `test/setup.ts` imports `kimiClientId`, verifies SHA-256 `9a51d8fba526c54bf355205a99c8325ec07a056024515f826987cb2a042a13ac`, then assigns it to `globalThis.__AIO_PROXY_KIMI_CLIENT_ID__`.

- [ ] **Step 2: Write the failing identity-header test**

```ts
import { expect, test } from "bun:test";
import { kimiIdentityHeaders } from "./headers";

test("builds stable printable Kimi identity headers around the credential device ID", () => {
  const headers = kimiIdentityHeaders("device-1", {
    hostname: () => "主机 name",
    platform: () => "darwin",
    release: () => "26.0",
    arch: () => "arm64",
    version: () => "Darwin 25.0 主机",
  });
  expect(headers).toMatchObject({
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Device-Id": "device-1",
    "X-Msh-Device-Name": "name",
    "X-Msh-Device-Model": "macOS 26.0 arm64",
    "X-Msh-Os-Version": "Darwin 25.0",
  });
  expect(Object.values(headers).every((value) => /^[\x20-\x7e]+$/u.test(value))).toBe(true);
});
```

- [ ] **Step 3: Run the test and verify RED**

Run: `bun run --filter @aio-proxy/plugin-kimi-code test:unit -- src/headers.test.ts`

Expected: FAIL because `./headers` does not yet export `kimiIdentityHeaders`.

- [ ] **Step 4: Implement the minimum header builder**

```ts
import * as systemOs from "node:os";
import packageJson from "../package.json" with { type: "json" };

type OsPort = Pick<typeof systemOs, "hostname" | "platform" | "release" | "arch" | "version">;

const printable = (value: string, fallback = "unknown") =>
  value.replace(/[^\x20-\x7e]/gu, "").trim() || fallback;

export function kimiIdentityHeaders(
  deviceId: string,
  os: OsPort = systemOs,
): Readonly<Record<string, string>> {
  const platform = os.platform();
  const name = platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform;
  return Object.freeze({
    "User-Agent": `KimiCLI/${packageJson.version}`,
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": packageJson.version,
    "X-Msh-Device-Name": printable(os.hostname()),
    "X-Msh-Device-Model": printable(`${name} ${os.release()} ${os.arch()}`),
    "X-Msh-Os-Version": printable(os.version()),
    "X-Msh-Device-Id": printable(deviceId),
  });
}
```

- [ ] **Step 5: Verify GREEN and update the workspace lockfile**

Run: `bun run --filter @aio-proxy/plugin-kimi-code test:unit -- src/headers.test.ts`

Expected: PASS.

Run: `bun install --lockfile-only`

Expected: `bun.lock` contains `@aio-proxy/plugin-kimi-code` with workspace dependencies only.

- [ ] **Step 6: Commit**

```sh
git add packages/plugins/kimi-code bun.lock
git commit -m "feat(kimi): add OAuth plugin package shell" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Device OAuth and credential refresh

**Files:**
- Create: `packages/plugins/kimi-code/src/oauth.test.ts`
- Create: `packages/plugins/kimi-code/src/oauth.ts`

**Interfaces:**
- Produces: `KimiCredential`
- Produces: `loginKimi(context, presentation, dependencies?)`
- Produces: `refreshKimiCredential(current, options?)`
- Produces: `currentKimiCredential(port, options?)`
- Consumes: `kimiIdentityHeaders(deviceId)`

- [ ] **Step 1: Write failing device-flow tests**

Use an injected fetch, clock, sleep, and device ID so the tests never contact Kimi. One table-driven test must assert request order and form bodies for pending → slow_down → success:

```ts
const result = await loginKimi(loginContext, presentation, {
  deviceId: () => "device-1",
  now: () => 1_700_000_000_000,
  sleep: async (ms) => waits.push(ms),
  fetch: sequence([
    Response.json({
      device_code: "device-code",
      user_code: "ABCD",
      verification_uri: "https://kimi.test/device",
      expires_in: 900,
      interval: 2,
    }),
    Response.json({ error: "authorization_pending" }),
    Response.json({ error: "slow_down", interval: 10 }),
    Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
  ]),
});

expect(waits).toEqual([2_000, 10_000]);
expect(result).toMatchObject({
  suggestedKey: expect.stringMatching(/^kimi-[0-9a-f]{12}$/u),
  label: "Kimi Code",
  credentials: { accessToken: "access", refreshToken: "refresh", deviceId: "device-1" },
  expiresAt: 1_700_003_600_000,
});
```

Add focused tests for `verification_uri_complete` fallback, `access_denied`, timeout, abort while sleeping, missing token fields, secret-free error surfaces, refresh token preservation/rotation, and refresh error classification (`401/403` non-retryable; network/429/5xx retryable).

- [ ] **Step 2: Run OAuth tests and verify RED**

Run: `bun run --filter @aio-proxy/plugin-kimi-code test:unit -- src/oauth.test.ts`

Expected: FAIL because the OAuth exports do not exist.

- [ ] **Step 3: Implement the RFC 8628 flow and refresh policy**

Implement these exact public types and entrypoints; private helpers parse JSON without embedding response bodies or credentials in errors:

```ts
import {
  CredentialRefreshError,
  type CredentialPort,
  type LocalizedText,
  type OAuthLoginContext,
} from "@aio-proxy/plugin-sdk";
import { kimiIdentityHeaders } from "./headers";

declare const __AIO_PROXY_KIMI_CLIENT_ID__: string;

export type KimiCredential = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly deviceId: string;
};

export type KimiOAuthDependencies = {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly deviceId?: () => string;
};

export type KimiLoginPresentation = {
  readonly instructions: LocalizedText;
  readonly waiting: LocalizedText;
};

export async function loginKimi(
  context: OAuthLoginContext,
  presentation: KimiLoginPresentation,
  dependencies: KimiOAuthDependencies = {},
) {
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? abortableSleep;
  const deviceId = dependencies.deviceId?.() ?? crypto.randomUUID().replaceAll("-", "");
  const device = await requestDeviceAuthorization(fetcher, deviceId, context.signal);
  await context.authorization.presentDeviceCode({
    url: device.verificationUriComplete ?? device.verificationUri,
    userCode: device.userCode,
    instructions: appendCode(presentation.instructions, device.userCode),
  });

  const deadline = now() + device.expiresIn * 1_000;
  let intervalMs = device.interval * 1_000;
  while (now() <= deadline) {
    context.signal.throwIfAborted();
    const token = await requestToken(fetcher, deviceId, context.signal, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.deviceCode,
    });
    if (token.accessToken !== undefined) {
      const credential = completeCredential(token, deviceId, now());
      const fingerprint = await sha256(credential.refreshToken);
      return {
        fingerprint,
        suggestedKey: `kimi-${fingerprint.slice(0, 12)}`,
        label: "Kimi Code",
        credentials: credential,
        expiresAt: credential.expiresAt,
      };
    }
    if (token.error === "authorization_pending") {
      context.progress(presentation.waiting);
      await sleep(intervalMs, context.signal);
      continue;
    }
    if (token.error === "slow_down") {
      intervalMs = Math.max(intervalMs + 5_000, (token.interval ?? 0) * 1_000);
      await sleep(intervalMs, context.signal);
      continue;
    }
    if (token.error === "expired_token") throw new Error("Kimi device authorization expired");
    if (token.error === "access_denied") throw new Error("Kimi device authorization denied");
    throw new Error("Kimi device authorization failed");
  }
  throw new Error("Kimi device authorization timed out");
}

export async function refreshKimiCredential(
  current: KimiCredential,
  options: KimiOAuthDependencies & { readonly signal?: AbortSignal } = {},
): Promise<KimiCredential> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let response: Response;
  try {
    response = await fetcher("https://auth.kimi.com/api/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...kimiIdentityHeaders(current.deviceId) },
      body: new URLSearchParams({
        client_id: __AIO_PROXY_KIMI_CLIENT_ID__,
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
      }),
      signal: options.signal,
    });
  } catch {
    throw new CredentialRefreshError("Kimi credential refresh failed", {
      retryable: true,
      reason: "network",
    });
  }
  if (!response.ok) {
    throw new CredentialRefreshError("Kimi credential refresh failed", {
      retryable: response.status === 429 || response.status >= 500,
      reason: response.status === 401 || response.status === 403 ? "rejected" : "http",
      status: response.status,
    });
  }
  const token = await parseSuccessfulToken(response);
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? current.refreshToken,
    expiresAt: now() + token.expiresIn * 1_000,
    deviceId: current.deviceId,
  };
}

export async function currentKimiCredential(
  port: CredentialPort<KimiCredential>,
  options: KimiOAuthDependencies = {},
): Promise<KimiCredential> {
  const current = await port.read();
  const now = options.now ?? Date.now;
  if (current.value.expiresAt > now() + 5 * 60_000) return current.value;
  return (
    await port.refresh(current.revision, async ({ value }, signal) => {
      const refreshed = await refreshKimiCredential(value, { ...options, signal });
      return { value: refreshed, metadata: { expiresAt: refreshed.expiresAt } };
    })
  ).snapshot.value;
}
```

Private helpers must:

- POST `client_id` to `/api/oauth/device_authorization` with identity headers.
- Default `expires_in` to 900 and `interval` to 5; reject missing device/user/verification fields.
- Always include `client_id` in token requests.
- Accept `refresh_token` as optional only on refresh, never on initial login.
- Append the user code to string or localized-object instructions.
- Implement abortable sleep with an abort listener removed on resolve.
- Hash with `crypto.subtle.digest("SHA-256", ...)` and lowercase hexadecimal output.

- [ ] **Step 4: Verify GREEN**

Run: `bun run --filter @aio-proxy/plugin-kimi-code test:unit -- src/oauth.test.ts`

Expected: PASS with no real network access and no timer leakage.

- [ ] **Step 5: Commit**

```sh
git add packages/plugins/kimi-code/src/oauth.ts packages/plugins/kimi-code/src/oauth.test.ts
git commit -m "feat(kimi): implement device OAuth flow" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Dynamic model catalog with static first-login fallback

**Files:**
- Create: `packages/plugins/kimi-code/src/catalog.test.ts`
- Create: `packages/plugins/kimi-code/src/catalog.ts`

**Interfaces:**
- Produces: `KIMI_CATALOG_TTL_MS`
- Produces: `discoverKimiCatalog(context, dependencies?)`
- Produces: `staticKimiCatalog()`
- Consumes: `currentKimiCredential()` and `kimiIdentityHeaders()`

- [ ] **Step 1: Write the failing catalog tests**

Test an authenticated `/coding/v1/models` response containing valid, blank, Anthropic, null-protocol, and unknown-protocol rows. Assert only nonblank IDs survive, `display_name` maps to `displayName`, Anthropic maps to `anthropic`, and every other protocol maps to `openai-compatible`. Also assert non-2xx and malformed roots reject without including tokens or raw response text.

```ts
expect(await discoverKimiCatalog(context, { fetch })).toEqual({
  language: [
    { id: "kimi-for-coding", displayName: "Kimi for Coding", metadata: { protocol: "openai-compatible" } },
    { id: "k3", displayName: "K3", metadata: { protocol: "anthropic" } },
  ],
  image: [], embedding: [], speech: [], transcription: [], reranking: [],
});
expect(staticKimiCatalog().language).toEqual([
  { id: "kimi-for-coding", displayName: "Kimi for Coding", metadata: { protocol: "openai-compatible" } },
]);
```

- [ ] **Step 2: Run the catalog tests and verify RED**

Run: `bun run --filter @aio-proxy/plugin-kimi-code test:unit -- src/catalog.test.ts`

Expected: FAIL because `catalog.ts` does not exist.

- [ ] **Step 3: Implement catalog discovery**

```ts
import type { AccountContext, ModelCatalog, ModelDescriptor } from "@aio-proxy/plugin-sdk";
import { currentKimiCredential, type KimiCredential, type KimiOAuthDependencies } from "./oauth";
import { kimiIdentityHeaders } from "./headers";

export const KIMI_CATALOG_TTL_MS = 6 * 60 * 60_000;

const empty = (language: readonly ModelDescriptor[]): ModelCatalog => ({
  language, image: [], embedding: [], speech: [], transcription: [], reranking: [],
});

export function staticKimiCatalog(): ModelCatalog {
  return empty([{ id: "kimi-for-coding", displayName: "Kimi for Coding", metadata: { protocol: "openai-compatible" } }]);
}

export async function discoverKimiCatalog(
  context: AccountContext<KimiCredential, Record<string, never>>,
  dependencies: KimiOAuthDependencies = {},
): Promise<ModelCatalog> {
  const credential = await currentKimiCredential(context.credentials, dependencies);
  const response = await (dependencies.fetch ?? globalThis.fetch)("https://api.kimi.com/coding/v1/models", {
    headers: { Authorization: `Bearer ${credential.accessToken}`, ...kimiIdentityHeaders(credential.deviceId) },
    signal: context.signal,
  });
  if (!response.ok) throw new Error(`Kimi model catalog request failed with ${response.status}`);
  const root: unknown = await response.json();
  if (typeof root !== "object" || root === null || !Array.isArray(Reflect.get(root, "data"))) {
    throw new Error("Kimi model catalog response is invalid");
  }
  const language = Reflect.get(root, "data").flatMap((value: unknown): ModelDescriptor[] => {
    if (typeof value !== "object" || value === null) return [];
    const id = Reflect.get(value, "id");
    if (typeof id !== "string" || id.trim() === "") return [];
    const displayName = Reflect.get(value, "display_name");
    return [{
      id: id.trim(),
      ...(typeof displayName === "string" && displayName.trim() !== "" ? { displayName: displayName.trim() } : {}),
      metadata: { protocol: Reflect.get(value, "protocol") === "anthropic" ? "anthropic" : "openai-compatible" },
    }];
  });
  return empty(language);
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `bun run --filter @aio-proxy/plugin-kimi-code test:unit -- src/catalog.test.ts`

Expected: PASS.

```sh
git add packages/plugins/kimi-code/src/catalog.ts packages/plugins/kimi-code/src/catalog.test.ts
git commit -m "feat(kimi): discover coding models" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Read-only Kimi quota capability

**Files:**
- Create: `packages/plugins/kimi-code/src/quota.test.ts`
- Create: `packages/plugins/kimi-code/src/quota.ts`

**Interfaces:**
- Produces: `readKimiQuota(context, dependencies?) -> OAuthQuotaSnapshot`
- Consumes: `currentKimiCredential()` and `kimiIdentityHeaders()`

- [ ] **Step 1: Write the failing quota behavior test**

Use the CodexBar response shape with numeric/string mixes and every reset-key variant. Assert the top-level item and every valid limit are preserved, the current credential is used, and invalid zero/missing limits are dropped:

```ts
const snapshot = await readKimiQuota(context, { fetch, now: () => 1_700_000_000_000 });
expect(snapshot).toEqual({
  items: [
    { id: "weekly", label: { default: "Weekly quota", "zh-Hans": "周配额" }, remainingRatio: 0.75, resetsAt: 1_767_972_193_000 },
    { id: "300-time-unit-minute", label: { default: "300 minute quota", "zh-Hans": "300 分钟配额" }, remainingRatio: 0.9, resetsAt: 1_767_713_582_000 },
    { id: "60-time-unit-minute", label: { default: "60 minute quota", "zh-Hans": "60 分钟配额" }, remainingRatio: 0.8 },
  ],
});
```

Add tests for `remaining / limit`, fallback `1 - used / limit`, clamping, fractional numeric strings, invalid rows, all-invalid response rejection, non-2xx rejection, abort propagation, and error surfaces that omit bearer tokens/raw bodies.

- [ ] **Step 2: Run quota tests and verify RED**

Run: `bun run --filter @aio-proxy/plugin-kimi-code test:unit -- src/quota.test.ts`

Expected: FAIL because `quota.ts` does not exist.

- [ ] **Step 3: Implement quota mapping without web endpoints or reset**

```ts
import type { AccountContext, OAuthQuotaItem, OAuthQuotaSnapshot } from "@aio-proxy/plugin-sdk";
import { kimiIdentityHeaders } from "./headers";
import { currentKimiCredential, type KimiCredential, type KimiOAuthDependencies } from "./oauth";

const numberValue = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

const resetTime = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value > 1_000_000_000_000 ? value : value * 1_000);
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

function item(
  value: unknown,
  id: string,
  label: OAuthQuotaItem["label"],
): OAuthQuotaItem | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const limit = numberValue(Reflect.get(value, "limit"));
  if (limit === undefined || limit <= 0) return undefined;
  const remaining = numberValue(Reflect.get(value, "remaining"));
  const used = numberValue(Reflect.get(value, "used"));
  const ratio = remaining === undefined ? (used === undefined ? undefined : 1 - used / limit) : remaining / limit;
  const rawReset = ["resetTime", "resetAt", "reset_time", "reset_at"]
    .map((key) => Reflect.get(value, key))
    .find((candidate) => candidate !== undefined);
  const resetsAt = resetTime(rawReset);
  return {
    id,
    label,
    ...(ratio === undefined ? {} : { remainingRatio: Math.min(1, Math.max(0, ratio)) }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

export async function readKimiQuota(
  context: AccountContext<KimiCredential, Record<string, never>>,
  dependencies: KimiOAuthDependencies = {},
): Promise<OAuthQuotaSnapshot> {
  const credential = await currentKimiCredential(context.credentials, dependencies);
  const response = await (dependencies.fetch ?? globalThis.fetch)("https://api.kimi.com/coding/v1/usages", {
    headers: { Accept: "application/json", Authorization: `Bearer ${credential.accessToken}`, ...kimiIdentityHeaders(credential.deviceId) },
    signal: context.signal,
  });
  if (!response.ok) throw new Error(`Kimi quota request failed with ${response.status}`);
  const root: unknown = await response.json();
  if (typeof root !== "object" || root === null) throw new Error("Kimi quota response is invalid");
  const weekly = item(Reflect.get(root, "usage"), "weekly", { default: "Weekly quota", "zh-Hans": "周配额" });
  const limits = Array.isArray(Reflect.get(root, "limits")) ? Reflect.get(root, "limits") as unknown[] : [];
  const windows = limits.flatMap((entry, index): OAuthQuotaItem[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const window = Reflect.get(entry, "window");
    const duration = typeof window === "object" && window !== null ? numberValue(Reflect.get(window, "duration")) : undefined;
    const unit = typeof window === "object" && window !== null && typeof Reflect.get(window, "timeUnit") === "string"
      ? String(Reflect.get(window, "timeUnit"))
      : "window";
    const normalizedUnit = unit.toLowerCase().replaceAll("_", "-");
    const id = `${duration ?? index}-${normalizedUnit}`;
    const shortUnit = unit.includes("MINUTE") ? "minute" : unit.includes("HOUR") ? "hour" : unit.includes("DAY") ? "day" : "window";
    const mapped = item(Reflect.get(entry, "detail"), id, {
      default: `${duration ?? index + 1} ${shortUnit} quota`,
      "zh-Hans": `${duration ?? index + 1} ${shortUnit === "minute" ? "分钟" : shortUnit === "hour" ? "小时" : shortUnit === "day" ? "天" : "窗口"}配额`,
    });
    return mapped === undefined ? [] : [mapped];
  });
  const items = [...(weekly === undefined ? [] : [weekly]), ...windows];
  if (items.length === 0) throw new Error("Kimi quota response contains no valid windows");
  return { items };
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `bun run --filter @aio-proxy/plugin-kimi-code test:unit -- src/quota.test.ts`

Expected: PASS.

```sh
git add packages/plugins/kimi-code/src/quota.ts packages/plugins/kimi-code/src/quota.test.ts
git commit -m "feat(kimi): expose coding quota windows" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Dual-protocol runtime and safe raw transport

**Files:**
- Create: `packages/plugins/kimi-code/src/runtime.test.ts`
- Create: `packages/plugins/kimi-code/src/runtime.ts`

**Interfaces:**
- Produces: `createKimiRuntime(context, dependencies?) -> OAuthRuntimeResult`
- Produces: `createKimiDynamicFetch(credentials, dependencies?)`
- Consumes: catalog metadata `{ protocol: "openai-compatible" | "anthropic" }`

- [ ] **Step 1: Write failing runtime tests**

Follow the existing GitHub Copilot runtime tests. Assert:

- `languageModel("openai-model").provider` contains `openai-compatible`.
- `languageModel("anthropic-model").provider` contains `anthropic`.
- Unknown model throws.
- AI SDK generation uses `/coding/v1/chat/completions` or `/coding/v1/messages`, current bearer token/device headers, caller abort signal, and no placeholder/`x-api-key`/`anthropic-api-key` credential.
- Raw resolver only matches the catalog protocol.
- Raw transport preserves method/body/query/client headers but rewrites only exact `/v1/chat/completions` and `/v1/messages`; unexpected paths reject before fetch.

- [ ] **Step 2: Run runtime tests and verify RED**

Run: `bun run --filter @aio-proxy/plugin-kimi-code test:unit -- src/runtime.test.ts`

Expected: FAIL because `runtime.ts` does not exist.

- [ ] **Step 3: Implement the provider and transport**

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { OAuthRuntimeResult, ProtocolId, RuntimeContext } from "@aio-proxy/plugin-sdk";
import { kimiIdentityHeaders } from "./headers";
import { currentKimiCredential, type KimiCredential, type KimiOAuthDependencies } from "./oauth";

type KimiProtocol = Extract<ProtocolId, "openai-compatible" | "anthropic">;
const PLACEHOLDER = "dynamic-credential";

export async function createKimiRuntime(
  context: RuntimeContext<KimiCredential, Record<string, never>>,
  dependencies: KimiOAuthDependencies = {},
): Promise<OAuthRuntimeResult> {
  const dynamicFetch = createKimiDynamicFetch(context.credentials, dependencies);
  const openai = createOpenAICompatible({
    name: "kimi-code.openai-compatible",
    baseURL: "https://api.kimi.com/coding/v1",
    apiKey: PLACEHOLDER,
    fetch: dynamicFetch,
  });
  const anthropic = createAnthropic({
    name: "kimi-code.anthropic",
    baseURL: "https://api.kimi.com/coding",
    authToken: PLACEHOLDER,
    fetch: dynamicFetch,
  });
  const protocols = new Map(
    context.catalog.language.flatMap((model) => {
      const protocol = catalogProtocol(model.metadata);
      return protocol === undefined ? [] : [[model.id, protocol] as const];
    }),
  );
  return {
    provider: {
      specificationVersion: "v4",
      languageModel(modelId) {
        const protocol = protocols.get(modelId);
        if (protocol === "anthropic") return anthropic.languageModel(modelId);
        if (protocol === "openai-compatible") return openai.languageModel(modelId);
        throw new Error(`Kimi Code model ${modelId} has no supported protocol metadata`);
      },
      embeddingModel: (modelId) => openai.embeddingModel(modelId),
      imageModel: (modelId) => openai.imageModel(modelId),
    },
    raw(input) {
      const protocol = protocols.get(input.modelId);
      if (protocol === undefined || protocol !== input.protocol) return undefined;
      return {
        invoke: async (request) => dynamicFetch(rewriteRawRequest(request, protocol)),
      };
    },
  };
}

export function createKimiDynamicFetch(
  credentials: RuntimeContext<KimiCredential, Record<string, never>>["credentials"],
  dependencies: KimiOAuthDependencies = {},
): typeof fetch {
  return async (input, init) => {
    const credential = await currentKimiCredential(credentials, dependencies);
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    for (const key of ["authorization", "x-api-key", "anthropic-api-key"]) headers.delete(key);
    headers.set("authorization", `Bearer ${credential.accessToken}`);
    for (const [key, value] of Object.entries(kimiIdentityHeaders(credential.deviceId))) headers.set(key, value);
    return await (dependencies.fetch ?? globalThis.fetch)(request.url, {
      method: request.method,
      headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }),
      signal: init?.signal ?? (input instanceof Request ? input.signal : request.signal),
      redirect: request.redirect,
    });
  };
}

function rewriteRawRequest(request: Request, protocol: KimiProtocol): Request {
  const source = new URL(request.url);
  const expectedPath = protocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  if (source.pathname !== expectedPath) throw new Error(`Unsupported Kimi raw path: ${source.pathname}`);
  const target = new URL(`https://api.kimi.com/coding${expectedPath}`);
  target.search = source.search;
  return new Request(target, request);
}

function catalogProtocol(metadata: unknown): KimiProtocol | undefined {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined;
  const value = Reflect.get(metadata, "protocol");
  return value === "anthropic" || value === "openai-compatible" ? value : undefined;
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `bun run --filter @aio-proxy/plugin-kimi-code test:unit -- src/runtime.test.ts`

Expected: PASS for both AI SDK request shapes and raw path validation.

```sh
git add packages/plugins/kimi-code/src/runtime.ts packages/plugins/kimi-code/src/runtime.test.ts
git commit -m "feat(kimi): route coding protocols" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Assemble the adapter and embed the built-in plugin

**Files:**
- Create: `packages/plugins/kimi-code/src/plugin.test.ts`
- Create: `packages/plugins/kimi-code/src/plugin.ts`
- Create: `packages/plugins/kimi-code/src/index.ts`
- Create: `packages/plugins/kimi-code/oauth.smoke.ts`
- Modify: `packages/core/src/plugins/builtins.ts`
- Modify: `packages/core/src/plugins/builtins.test.ts`
- Modify: `packages/core/package.json`
- Modify: `packages/cli/src/plugin-commands/plugin/add.test.ts`
- Modify: `packages/cli/src/plugin-commands/provider-login/capability.test.ts`
- Modify: `packages/cli/_test/binary-build.test.ts`
- Modify: `bun.lock`

**Interfaces:**
- Produces: `createKimiCodePlugin(presentationText, dependencies?)`
- Produces: default built-in descriptor and `KIMI_CODE_PLUGIN_VERSION`

- [ ] **Step 1: Write failing adapter and host registration tests**

In `plugin.test.ts`, extract the registered adapter from the descriptor and assert:

```ts
expect(adapter.id).toBe("default");
expect(adapter.icon).toBe("moonshot");
expect(adapter.account.options.form).toEqual([]);
await expect(adapter.account.options.schema.parseAsync({})).resolves.toEqual({});
expect(adapter.catalog.policy).toEqual({ kind: "ttl", ttlMs: KIMI_CATALOG_TTL_MS });
expect(adapter.catalog.initialFallback?.(new Error("offline"))).toEqual(staticKimiCatalog());
expect(adapter.quota?.reset).toBeUndefined();
```

Inject localized strings and assert login instructions/progress and quota labels remain localized values rather than resolved host strings.

Update `expectedBuiltIns` and CLI built-in arrays with `@aio-proxy/plugin-kimi-code`, update built-in boolean/version assertions from three entries to four, and make the binary smoke require the Kimi package name.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```sh
bun run --filter @aio-proxy/plugin-kimi-code test:unit -- src/plugin.test.ts
bun test packages/core/src/plugins/builtins.test.ts
bun test packages/cli/src/plugin-commands/plugin/add.test.ts packages/cli/src/plugin-commands/provider-login/capability.test.ts
```

Expected: FAIL because the descriptor and embedded definition do not exist.

- [ ] **Step 3: Implement the adapter assembly**

```ts
import {
  type ConfigSpec,
  definePlugin,
  type LocalizedText,
  type OAuthAdapter,
  type PluginDescriptor,
  zod,
} from "@aio-proxy/plugin-sdk";
import { KIMI_CATALOG_TTL_MS, discoverKimiCatalog, staticKimiCatalog } from "./catalog";
import { loginKimi, type KimiCredential, type KimiOAuthDependencies } from "./oauth";
import { readKimiQuota } from "./quota";
import { createKimiRuntime } from "./runtime";

export type KimiCodePresentationText = {
  readonly pluginLabel?: LocalizedText;
  readonly pluginDescription?: LocalizedText;
  readonly adapterLabel: LocalizedText;
  readonly deviceInstructions: LocalizedText;
  readonly waitingForAuthorization: LocalizedText;
};

export const englishPresentationText: KimiCodePresentationText = {
  pluginLabel: "Kimi Code",
  pluginDescription: "Use a Kimi Code account to access models",
  adapterLabel: "Login with Kimi Code",
  deviceInstructions: "Enter code",
  waitingForAuthorization: "Waiting for Kimi authorization",
};

export function createKimiCodePlugin(
  presentationText: KimiCodePresentationText = englishPresentationText,
  dependencies: KimiOAuthDependencies = {},
): PluginDescriptor<undefined> {
  const accountOptions = {
    schema: zod.object({}),
    form: [],
  } as const satisfies ConfigSpec<Record<string, never>>;
  const adapter: OAuthAdapter<Record<string, never>, KimiCredential> = {
    id: "default",
    label: presentationText.adapterLabel,
    icon: "moonshot",
    account: { options: accountOptions },
    credentials: zod.object({
      accessToken: zod.string().min(1),
      refreshToken: zod.string().min(1),
      expiresAt: zod.number().int(),
      deviceId: zod.string().min(1),
    }),
    login: async (context, options) => {
      await accountOptions.schema.parseAsync(options);
      return await loginKimi(context, {
        instructions: presentationText.deviceInstructions,
        waiting: presentationText.waitingForAuthorization,
      }, dependencies);
    },
    catalog: {
      policy: { kind: "ttl", ttlMs: KIMI_CATALOG_TTL_MS },
      discover: (context) => discoverKimiCatalog(context, dependencies),
      initialFallback: (error) =>
        error instanceof DOMException && error.name === "AbortError" ? undefined : staticKimiCatalog(),
    },
    createRuntime: (context) => createKimiRuntime(context, dependencies),
    quota: { read: (context) => readKimiQuota(context, dependencies) },
  };
  return definePlugin((api) => api.oauth.register(adapter), {
    label: presentationText.pluginLabel ?? "Kimi Code",
    description: presentationText.pluginDescription ?? "Use a Kimi Code account to access models",
  });
}
```

`src/index.ts` imports package JSON, exports all public Kimi types/functions needed by core tests, defines `KIMI_CODE_PLUGIN_VERSION`, and default-exports `createKimiCodePlugin(englishPresentationText)`.

- [ ] **Step 4: Embed it in core and update package dependencies**

In `builtins.ts`, import the factory/version, append the package name to `BUILT_IN_PLUGIN_PACKAGE_NAMES`, and append this descriptor:

```ts
{
  packageName: "@aio-proxy/plugin-kimi-code",
  version: KIMI_CODE_PLUGIN_VERSION,
  descriptor: createKimiCodePlugin({
    pluginLabel: localized("Kimi Code", "Kimi Code"),
    pluginDescription: localized(
      "Use a Kimi Code account to access models",
      "使用 Kimi Code 账号访问模型",
    ),
    adapterLabel: localized("Login with Kimi Code", "使用 Kimi Code 登录"),
    deviceInstructions: localized("Enter code", "输入代码"),
    waitingForAuthorization: localized("Waiting for Kimi authorization", "正在等待 Kimi 授权"),
  }) as unknown as PluginDescriptor<unknown>,
}
```

Add `"@aio-proxy/plugin-kimi-code": "workspace:*"` to `packages/core/package.json`; do not add it to server because server consumes built-ins through core.

- [ ] **Step 5: Add and verify the artifact smoke test**

Mirror existing OAuth smoke tests. Assert source/config/setup do not contain the decoded client ID or its full base64, built `dist/oauth.js` contains the client ID, the define symbol is absent, and no runtime `atob()` remains.

Run:

```sh
bun install --lockfile-only
bun run --filter @aio-proxy/plugin-kimi-code test:unit
bun run --filter @aio-proxy/plugin-kimi-code build
bun run --filter @aio-proxy/plugin-kimi-code test:artifact
bun test packages/core/src/plugins/builtins.test.ts
bun test packages/cli/src/plugin-commands/plugin/add.test.ts packages/cli/src/plugin-commands/provider-login/capability.test.ts
```

Expected: all PASS; build output contains no type errors.

- [ ] **Step 6: Commit**

```sh
git add packages/plugins/kimi-code packages/core packages/cli bun.lock
git commit -m "feat(kimi): embed OAuth provider" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 7: Repository verification

**Files:**
- Modify only files required by failures caused by the Kimi plugin; do not broaden scope.

**Interfaces:**
- Produces: a clean full-repository verification result.

- [ ] **Step 1: Run formatting and static checks**

Run: `bun run check`

Expected: PASS. If Biome reports only formatting in changed files, run the repository's formatter on those files and rerun `bun run check`; do not reformat unrelated files.

- [ ] **Step 2: Run plugin and host unit tests**

Run:

```sh
bun run --filter @aio-proxy/plugin-kimi-code test:unit
bun test packages/core/src/plugins/builtins.test.ts
bun test packages/cli/src/plugin-commands/plugin/add.test.ts packages/cli/src/plugin-commands/provider-login/capability.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run artifact checks**

Run:

```sh
bun run --filter @aio-proxy/plugin-kimi-code build
bun run --filter @aio-proxy/plugin-kimi-code test:artifact
```

Expected: PASS; no plaintext client ID remains in source/config/setup and the built artifact has no unresolved define symbol.

- [ ] **Step 4: Run full preflight**

Run: `bun run preflight`

Expected: PASS for Biome, all unit suites, SDK type tests, all artifact tests, and task-graph verification.

- [ ] **Step 5: Inspect the final diff and commit any verification-only corrections**

Run:

```sh
git diff --check
git status --short
git diff --stat
```

Expected: only the Kimi plugin, built-in enumeration/tests, core dependency, CLI built-in expectations, and `bun.lock` are changed; `.reference` remains untracked and untouched.

If verification required a correction:

```sh
git add packages/plugins/kimi-code packages/core/src/plugins/builtins.ts packages/core/src/plugins/builtins.test.ts packages/core/package.json packages/cli/src/plugin-commands/plugin/add.test.ts packages/cli/src/plugin-commands/provider-login/capability.test.ts packages/cli/_test/binary-build.test.ts bun.lock
git commit -m "fix(kimi): satisfy repository verification" -m "Co-authored-by: Codex <noreply@openai.com>"
```
