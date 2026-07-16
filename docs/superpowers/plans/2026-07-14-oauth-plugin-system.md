# OAuth Plugin System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the vendor-switched OAuth implementation with a public plugin SDK, two embedded built-in OAuth plugins, host-owned authorization and persistence, and immutable server runtime snapshots.

**Architecture:** `@aio-proxy/plugin-sdk` owns the core-independent descriptor, ConfigSpec, OAuth adapter, authorization, credential, catalog, ProviderV4, and raw contracts. Core loads trusted descriptors into a staging registry, owns SQLite state and account transactions, and exposes immutable registry snapshots; CLI owns interactive forms and OAuth presentation, while server materializes registry accounts into the existing capability-based routing pipeline.

**Tech Stack:** TypeScript 6.0.3, Bun 1.3.14, Zod 4.4.3, AI SDK 7.0.8, `@ai-sdk/provider` 4.0.1, Drizzle ORM 0.45, SQLite WAL, Commander 15, Inquirer 8, Hono 4, React 19, TanStack Query/Table, Rslib, Rstest.

## Global Constraints

- Public descriptor compatibility is the exact integer `apiVersion: 1`; do not use semver ranges for the runtime protocol.
- The runtime seam is `ProviderV4` from `@ai-sdk/provider@4.0.1`; require `specificationVersion === "v4"`, `languageModel()`, `imageModel()`, and `embeddingModel()`.
- `files()` and `skills()` may pass runtime validation but remain outside v1 catalog and routing; `videoModel` is not part of the locked ProviderV4 contract.
- `@aio-proxy/plugin-sdk` must not import `@aio-proxy/core`, server, CLI, database code, or internal `ProviderProtocol`.
- `@aio-proxy/plugin-sdk` owns the public Zod runtime: it exports `zod` via `export { z as zod } from "zod"` plus Zod types, and plugin packages import schemas from the SDK instead of depending on `zod` directly.
- Plugin raw protocols are exactly `"openai-compatible" | "openai-response" | "anthropic" | "gemini"` and use Web `Request`/`Response`.
- Built-in package identities are `@aio-proxy/plugin-github-copilot` and `@aio-proxy/plugin-openai-chatgpt`; cached npm packages with those names never override embedded code.
- Workspace package directories are `packages/plugin-sdk/`, `packages/plugins/github-copilot/`, and `packages/plugins/openai-chatgpt/`.
- Third-party packages execute in-process only after explicit `plugin add` trust confirmation; server config never auto-installs a missing package.
- Config root/server/plugins errors reject startup or reload; each provider entry parses independently and an invalid or legacy OAuth entry becomes unavailable.
- Provider record keys are Provider IDs; OAuth entries do not persist a second `id` field.
- Login has a host deadline of 20 minutes; pending-operation recovery TTL is 30 minutes.
- Unreferenced account reconciliation uses a 30-minute grace and always skips accounts with a pending marker.
- Plugin import/setup/runtime deadlines are 10/5/5 seconds; catalog discovery/refresh deadline is 30 seconds.
- Refresh uses process-local single-flight, a 45-second SQLite lease renewed every 15 seconds, a 30-second upstream exchange deadline, and revision CAS.
- Config and SQLite are not treated as one transaction; account login uses a durable pending marker and conditional compensation.
- `provider login [capability]` creates a new account; only `--provider <id>` enters re-login and may retain existing account options/secrets.
- Plugin removal preserves account state and plugin-scoped secrets by default; only `--purge-secrets` removes plugin secrets, and `plugin prune` touches package cache only.
- Explicit provider deletion removes its config entry, account options secrets, credential, catalog, and account diagnostic.
- Dashboard v1 is read-only for plugin/OAuth configuration and login.
- Keep `packages/server/src/routes/pipeline.ts` as the only candidate loop; route files must not branch on plugin package, OAuth vendor, or provider kind.
- Preserve model-first routing, weight/config order, same-protocol raw preference, ProviderV4 cross-protocol invocation, fallback, recording, usage capture, and stream preflight.
- This is a clean break: do not migrate old OAuth config, auth payloads, or provider IDs.
- All user-facing built-in and host copy goes through `packages/i18n`; third-party strings are opaque and are not interpreted as i18n keys.
- Prefix execution commands with `PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk`.
- Every commit uses a conventional subject and the footer `Co-authored-by: Codex <noreply@openai.com>`.

---

## File Structure

- `packages/plugin-sdk/src/json.ts` owns SDK-local JSON values.
- `packages/plugin-sdk/src/config.ts` owns declarative host-rendered ConfigSpec fields.
- `packages/plugin-sdk/src/runtime.ts` owns catalog, protocol, raw resolver, and ProviderV4 runtime result types.
- `packages/plugin-sdk/src/oauth.ts` owns login, authorization, credential, account, and runtime contexts.
- `packages/plugin-sdk/src/plugin.ts` owns the branded v1 descriptor and registration API.
- `packages/core/src/plugins/schema.ts` validates and safely parses the Zod schemas exposed through the plugin SDK.
- `packages/core/src/plugins/config-spec.ts` validates untrusted declarative form metadata before CLI rendering or secret splitting.
- `packages/core/src/plugins/registry.ts` validates adapters and commits one plugin's staging registrations atomically.
- `packages/core/src/plugins/loader.ts` resolves built-in or cached npm packages and returns plugin states plus a committed registry.
- `packages/core/src/plugins/builtins.ts` binds reserved package identities to embedded descriptors and localized copy.
- `packages/core/src/plugins/repository.ts` is the only SQL-facing OAuth/plugin vault and catalog repository.
- `packages/core/src/plugins/credential-port.ts` owns single-flight, lease, schema validation, and revision CAS refresh.
- `packages/core/src/plugins/account-login.ts` owns deterministic Provider IDs, pending markers, login commit, compensation, and recovery.
- `packages/core/src/plugins/config-file.ts` performs mode-preserving atomic JSON config replacement and provider-entry digesting.
- `packages/cli/src/plugin-commands/form.ts` renders all six ConfigSpec field types and splits public values from secrets.
- `packages/cli/src/plugin-commands/authorization.ts` presents device codes and delegates loopback sessions.
- `packages/cli/src/plugin-commands/loopback.ts` owns callback listeners, manual callback URL fallback, validation, timeout, and cleanup.
- `packages/cli/src/plugin-commands/plugin.ts` implements plugin add/list/config/remove/prune.
- `packages/cli/src/plugin-commands/provider-login.ts` resolves a capability and runs the host login transaction.
- `packages/plugins/github-copilot/` owns GitHub account configuration, device flow, Copilot refresh/discovery, ProviderV4, and raw transport.
- `packages/plugins/openai-chatgpt/` owns PKCE/state, token exchange/refresh, static catalog, ChatGPT ProviderV4, and dynamic auth fetch.
- `packages/server/src/plugin-runtime.ts` materializes available OAuth accounts into routing capabilities.
- `packages/server/src/catalog-scheduler.ts` schedules host-owned static/TTL catalog refresh without plugin lifecycle hooks.
- `packages/server/src/server-state.ts` builds and atomically swaps registry/provider/runtime/router snapshots.
- `packages/types/src/plugin.ts` owns config-facing plugin references, safe diagnostics, and plugin/provider states.
- `packages/dashboard/src/modules/providers/components/plugins-table.tsx` and `provider-state-cell.tsx` render read-only state.

### Task 1: Publish the Plugin SDK Contract

**Files:**
- Create: `packages/plugin-sdk/package.json`
- Create: `packages/plugin-sdk/rslib.config.ts`
- Create: `packages/plugin-sdk/tsconfig.json`
- Create: `packages/plugin-sdk/src/json.ts`
- Create: `packages/plugin-sdk/src/config.ts`
- Create: `packages/plugin-sdk/src/runtime.ts`
- Create: `packages/plugin-sdk/src/oauth.ts`
- Create: `packages/plugin-sdk/src/plugin.ts`
- Create: `packages/plugin-sdk/src/index.ts`
- Create: `packages/plugin-sdk/_test/descriptor.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `bun.lock`

**Interfaces:**
- Produces: `definePlugin()`, `PluginDescriptor`, `PluginApi`, `ConfigSpec`, `OAuthAdapter`, `CredentialPort`, `ModelCatalog`, `ProtocolId`, `RawResolver`, and `OAuthRuntimeResult`.
- Produces: `PLUGIN_API_VERSION = 1` and the shared `Symbol.for("@aio-proxy/plugin-sdk/descriptor/v1")` brand.
- Consumes: only `zod` and `@ai-sdk/provider`; no internal package.

- [ ] **Step 1: Write the failing descriptor contract tests**

```ts
import { describe, expect, test } from "bun:test";
import {
  definePlugin,
  isPluginDescriptor,
  PLUGIN_API_VERSION,
  PLUGIN_DESCRIPTOR_BRAND,
  zod,
} from "../src";

describe("definePlugin", () => {
  test("brands an apiVersion 1 descriptor", () => {
    const descriptor = definePlugin(() => {});
    expect(descriptor.apiVersion).toBe(1);
    expect(descriptor[PLUGIN_DESCRIPTOR_BRAND]).toBe(true);
    expect(isPluginDescriptor(descriptor)).toBe(true);
  });

  test("retains a plugin ConfigSpec without executing setup", () => {
    let calls = 0;
    const options = { schema: zod.object({ baseURL: zod.url() }), form: [] } as const;
    const descriptor = definePlugin(() => {
      calls += 1;
    }, { options });

    expect(descriptor.metadata.options).toBe(options);
    expect(calls).toBe(0);
    expect(PLUGIN_API_VERSION).toBe(1);
  });

  test("rejects unbranded lookalikes", () => {
    expect(isPluginDescriptor({ apiVersion: 1, setup() {} })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the SDK test to verify it fails**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/plugin-sdk/_test/descriptor.test.ts
```

Expected: FAIL because `packages/plugin-sdk` and its exports do not exist.

- [ ] **Step 3: Add the workspace and package manifests**

In root `package.json`, add `"packages/plugins/*"` to `workspaces.packages` and add:

```json
"i18n:compile": "bun run --filter @aio-proxy/i18n build"
```

Create `packages/plugin-sdk/package.json`:

```json
{
  "name": "@aio-proxy/plugin-sdk",
  "version": "0.0.0",
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
    "test:unit": "bun test _test"
  },
  "dependencies": {
    "@ai-sdk/provider": "catalog:",
    "zod": "catalog:"
  },
  "devDependencies": {
    "@aio-proxy/infra": "workspace:*",
    "@rslib/core": "catalog:",
    "typescript": "catalog:"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

Create `rslib.config.ts` with `defineLibraryConfig()` and create a strict package `tsconfig.json` extending `@aio-proxy/infra/tsconfig/base.json`. Add `./packages/plugin-sdk` before core in the root project references.

- [ ] **Step 4: Implement the complete SDK types**

Create `src/json.ts`:

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
```

Create `src/config.ts`:

```ts
import type { ZodType } from "zod";
import type { JsonValue } from "./json";

export type FormCondition = {
  readonly key: string;
  readonly equals: string | number | boolean | null;
};

type FormFieldBase<TType extends string> = {
  readonly type: TType;
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly when?: FormCondition;
};

export type FormField =
  | (FormFieldBase<"text"> & { readonly placeholder?: string })
  | (FormFieldBase<"secret"> & { readonly placeholder?: string })
  | (FormFieldBase<"number"> & { readonly placeholder?: string })
  | (FormFieldBase<"boolean"> & { readonly defaultValue?: boolean })
  | (FormFieldBase<"select"> & {
      readonly options: readonly {
        readonly value: string | number | boolean;
        readonly label: string;
        readonly description?: string;
      }[];
    })
  | (FormFieldBase<"json"> & {
      readonly placeholder?: string;
      readonly defaultValue?: JsonValue;
    });

export type ConfigSpec<T> = {
  readonly schema: ZodType<T>;
  readonly form: readonly FormField[];
};
```

Create `src/runtime.ts`:

```ts
import type { ProviderV4 } from "@ai-sdk/provider";
import type { JsonValue } from "./json";

export type ProtocolId = "openai-compatible" | "openai-response" | "anthropic" | "gemini";

export type RawTransport = {
  readonly invoke: (request: Request) => Promise<Response>;
};

export type RawResolver = (input: {
  readonly protocol: ProtocolId;
  readonly modelId: string;
  readonly metadata?: JsonValue;
}) => RawTransport | undefined;

export type ModelDescriptor = {
  readonly id: string;
  readonly displayName?: string;
  readonly metadata?: JsonValue;
};

export type ModelCatalog = {
  readonly language: readonly ModelDescriptor[];
  readonly image: readonly ModelDescriptor[];
  readonly embedding: readonly ModelDescriptor[];
  readonly speech: readonly ModelDescriptor[];
  readonly transcription: readonly ModelDescriptor[];
  readonly reranking: readonly ModelDescriptor[];
};

export type OAuthRuntimeResult = {
  readonly provider: ProviderV4;
  readonly raw?: RawResolver;
};
```

Create `src/oauth.ts`:

```ts
import type { ZodType } from "zod";
import type { ConfigSpec } from "./config";
import type { ModelCatalog, OAuthRuntimeResult } from "./runtime";

export type DeviceCodePresentation = {
  readonly url: string;
  readonly userCode: string;
  readonly instructions?: string;
};

export type LoopbackRequest = {
  readonly state: string;
  readonly redirect: {
    readonly hostname: "localhost" | "127.0.0.1";
    readonly port: number | "dynamic";
    readonly path: `/${string}`;
  };
  readonly authorizationUrl: (input: { readonly redirectUri: string }) => string;
  readonly allowManualCallbackUrl: boolean;
};

export type AuthorizationPort = {
  readonly presentDeviceCode: (input: DeviceCodePresentation) => Promise<void>;
  readonly loopback: (input: LoopbackRequest) => Promise<{ readonly code: string; readonly redirectUri: string }>;
};

export type OAuthLoginContext = {
  readonly authorization: AuthorizationPort;
  readonly progress: (message: string) => void;
  readonly signal: AbortSignal;
};

export type OAuthLoginResult<Credential> = {
  readonly fingerprint: string;
  readonly suggestedKey: string;
  readonly label?: string;
  readonly credentials: Credential;
  readonly expiresAt?: number;
};

export type CredentialSnapshot<Credential> = {
  readonly value: Credential;
  readonly revision: number;
};

export type CredentialPort<Credential> = {
  readonly read: () => Promise<CredentialSnapshot<Credential>>;
  readonly refresh: (
    expectedRevision: number,
    exchange: (
      current: CredentialSnapshot<Credential>,
      signal: AbortSignal,
    ) => Promise<{
      readonly value: Credential;
      readonly metadata?: { readonly label?: string; readonly expiresAt?: number };
    }>,
  ) => Promise<
    | { readonly status: "updated"; readonly snapshot: CredentialSnapshot<Credential> }
    | { readonly status: "superseded"; readonly snapshot: CredentialSnapshot<Credential> }
  >;
};

export type AccountContext<Credential, AccountOptions> = {
  readonly credentials: CredentialPort<Credential>;
  readonly options: AccountOptions;
  readonly signal: AbortSignal;
};

export type RuntimeContext<Credential, AccountOptions> = {
  readonly credentials: CredentialPort<Credential>;
  readonly options: AccountOptions;
  readonly catalog: ModelCatalog;
};

export type OAuthAdapter<AccountOptions = unknown, Credential = unknown> = {
  readonly id: string;
  readonly label: string;
  readonly account: { readonly options: ConfigSpec<AccountOptions> };
  readonly credentials: ZodType<Credential>;
  readonly login: (
    context: OAuthLoginContext,
    options: AccountOptions,
  ) => Promise<OAuthLoginResult<Credential>>;
  readonly catalog: {
    readonly policy: { readonly kind: "static" } | { readonly kind: "ttl"; readonly ttlMs: number };
    readonly discover: (
      context: AccountContext<Credential, AccountOptions>,
    ) => Promise<ModelCatalog>;
  };
  readonly createRuntime: (
    context: RuntimeContext<Credential, AccountOptions>,
  ) => Promise<OAuthRuntimeResult>;
};
```

Create `src/plugin.ts`:

```ts
import type { ConfigSpec } from "./config";
import type { OAuthAdapter } from "./oauth";

export const PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_DESCRIPTOR_BRAND = Symbol.for("@aio-proxy/plugin-sdk/descriptor/v1");

export type PluginApi = {
  readonly oauth: {
    readonly register: (adapter: OAuthAdapter) => void;
  };
};

export type PluginDescriptor<Options = undefined> = {
  readonly [PLUGIN_DESCRIPTOR_BRAND]: true;
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  readonly metadata: { readonly options?: ConfigSpec<Options> };
  readonly setup: (api: PluginApi, options: Options) => void | Promise<void>;
};

export function definePlugin<Options = undefined>(
  setup: PluginDescriptor<Options>["setup"],
  metadata: PluginDescriptor<Options>["metadata"] = {},
): PluginDescriptor<Options> {
  return Object.freeze({
    [PLUGIN_DESCRIPTOR_BRAND]: true,
    apiVersion: PLUGIN_API_VERSION,
    metadata,
    setup,
  });
}

export function isPluginDescriptor(value: unknown): value is PluginDescriptor<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, PLUGIN_DESCRIPTOR_BRAND) === true &&
    Reflect.get(value, "apiVersion") === PLUGIN_API_VERSION &&
    typeof Reflect.get(value, "setup") === "function"
  );
}
```

Export every public type and function from `src/index.ts`, plus the SDK-owned Zod runtime under the public name `zod` and the schema types:

```ts
export { z as zod } from "zod";
export type { ZodIssue, ZodType } from "zod";
```

- [ ] **Step 5: Build and verify the SDK boundary**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun install
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/plugin-sdk build
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/plugin-sdk/_test/descriptor.test.ts
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk rg -n '@aio-proxy/(core|server|cli)|ProviderProtocol' packages/plugin-sdk/src
```

Expected: build and tests PASS; the final search prints no matches.

- [ ] **Step 6: Commit the SDK**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git add package.json bun.lock tsconfig.json packages/plugin-sdk
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git commit -m "feat(plugin-sdk): define oauth plugin contract" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Add Plugin Enablement and Diagnostic Types

**Files:**
- Create: `packages/types/src/plugin.ts`
- Modify: `packages/types/src/provider.ts`
- Modify: `packages/types/src/config.ts`
- Modify: `packages/types/src/index.ts`
- Modify: `packages/types/_test/schemas.test.ts`
- Modify: `packages/types/_test/config.test.ts`
- Modify: `packages/types/_test/example-config.test.ts`

**Interfaces:**
- Produces: `PluginPackageNameSchema`, `CapabilityIdSchema`, `PluginEnablement`, `Diagnostic`, `DiagnosticCode`, `PluginState`, `ProviderState`, and `InvalidProviderConfig`.
- Produces: `Config.plugins` while preserving the current provider parser until the vertical cutover in Task 11.
- Produces: an exported `OAuthPluginProviderSchema` for new code to compile against before it becomes the active OAuth schema.
- Preserves: the current `OAuthProviderSchema`, `OAuthVendor`, and `Config.providers` behavior so the existing server remains green through Tasks 3–10.

- [ ] **Step 1: Add failing plugin config and state tests**

Add this config-shape coverage:

```ts
const config = ConfigSchema.parse({
  plugins: [["@example/enterprise", { baseURL: "https://example.test" }]],
  providers: {
    legacyDuringScaffolding: { kind: "oauth", vendor: "github-copilot" },
  },
});

expect(config.plugins).toEqual([
  { packageName: "@example/enterprise", options: { baseURL: "https://example.test" } },
]);
expect(config.providers[0]).toMatchObject({
  id: "legacyDuringScaffolding",
  kind: "oauth",
  vendor: "github-copilot",
});

expect(() =>
  ConfigSchema.parse({
    plugins: ["@example/duplicate", "@example/duplicate"],
    providers: {},
  }),
).toThrow("Duplicate plugin @example/duplicate");
```

Also assert `OAuthPluginProviderSchema` accepts:

```ts
{
  id: "copilot-12345",
  kind: "oauth",
  plugin: "@aio-proxy/plugin-github-copilot",
  capability: "default",
  options: { deploymentType: "github.com" }
}
```

Add table-driven schema tests for every `DiagnosticCodeSchema` member, both `PluginStateSchema` members, both `ProviderStateSchema` members, malformed `plugins`, and preservation of existing provider ordering. Assert `InvalidProviderConfig` carries only `id`, optional inferred `kind`, stable `code`, and safe issue paths; it must never carry the raw provider value.

- [ ] **Step 2: Run Types tests to verify they fail**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/types/_test/schemas.test.ts packages/types/_test/config.test.ts
```

Expected: FAIL because plugin config, diagnostic states, and the staged structured OAuth schema do not exist.

- [ ] **Step 3: Define safe diagnostics and state unions**

Create `packages/types/src/plugin.ts`:

```ts
import { z } from "zod";
import type { ProviderKind } from "./provider";

export const PluginPackageNameSchema = z
  .string()
  .trim()
  .regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u);

export const CapabilityIdSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9._-]*$/u);

export const DiagnosticCodeSchema = z.enum([
  "PLUGIN_NOT_INSTALLED",
  "PLUGIN_API_INCOMPATIBLE",
  "PLUGIN_LOAD_FAILED",
  "PLUGIN_OPTIONS_INVALID",
  "PROVIDER_CONFIG_INVALID",
  "LEGACY_OAUTH_CONFIG_UNSUPPORTED",
  "CAPABILITY_MISSING",
  "ACCOUNT_OPTIONS_INVALID",
  "CREDENTIALS_MISSING_OR_INVALID",
  "CREDENTIAL_REFRESH_FAILED",
  "AUTHORIZATION_FAILED",
  "CATALOG_UNAVAILABLE",
  "RUNTIME_CREATE_FAILED",
]);

export const DiagnosticSchema = z.object({
  code: DiagnosticCodeSchema,
  summary: z.string().min(1),
  retryable: z.boolean(),
  occurredAt: z.string().datetime(),
  suggestedCommand: z.string().min(1).optional(),
});

export const PluginStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready") }),
  z.object({ status: z.literal("failed"), diagnostic: DiagnosticSchema }),
]);

export const ProviderStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    catalog: z.enum(["fresh", "stale"]).optional(),
    diagnostic: DiagnosticSchema.optional(),
  }),
  z.object({ status: z.literal("unavailable"), diagnostic: DiagnosticSchema }),
]);

export type DiagnosticCode = z.output<typeof DiagnosticCodeSchema>;
export type Diagnostic = z.output<typeof DiagnosticSchema>;
export type PluginState = z.output<typeof PluginStateSchema>;
export type ProviderState = z.output<typeof ProviderStateSchema>;

export type PluginEnablement = {
  readonly packageName: string;
  readonly options?: unknown;
};

export type InvalidProviderConfig = {
  readonly id: string;
  readonly kind?: ProviderKind;
  readonly code: "PROVIDER_CONFIG_INVALID" | "LEGACY_OAUTH_CONFIG_UNSUPPORTED";
  readonly issuePaths: readonly (readonly (string | number)[])[];
};
```

OAuth ready states always set `catalog`; API/AI SDK ready states omit it. Add tests for both shapes so consumers do not synthesize catalog freshness for non-OAuth providers.

- [ ] **Step 4: Add the staged structured OAuth schema without activating it**

In `provider.ts`, retain `OAuthProviderSchema` and add:

```ts
import { CapabilityIdSchema, PluginPackageNameSchema } from "./plugin";

export const OAuthPluginProviderSchema = z.object({
  kind: z.literal(ProviderKind.OAuth).describe("Provider backed by a plugin OAuth account."),
  ...SharedProviderSchemaBase,
  plugin: PluginPackageNameSchema,
  capability: CapabilityIdSchema,
  options: z.record(z.string(), z.unknown()).optional(),
});

export type OAuthPluginProviderInput = z.input<typeof OAuthPluginProviderSchema>;
export type OAuthPluginProvider = z.output<typeof OAuthPluginProviderSchema>;
```

New plugin host code may use `OAuthPluginProvider`; existing CLI/server code continues using the legacy `OAuthProvider` type until Task 11.

- [ ] **Step 5: Add plugin enablement to the root config**

In `config.ts`, import `PluginPackageNameSchema` from `plugin.ts` and parse plugin entries with:

```ts
const PluginEnablementSchema = z
  .union([PluginPackageNameSchema, z.tuple([PluginPackageNameSchema, z.unknown()])])
  .transform((entry) =>
    typeof entry === "string" ? { packageName: entry } : { packageName: entry[0], options: entry[1] },
  );

const PluginsInputSchema = z
  .array(PluginEnablementSchema)
  .default([])
  .superRefine((plugins, context) => {
    const seen = new Set<string>();
    for (const [index, plugin] of plugins.entries()) {
      if (seen.has(plugin.packageName)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate plugin ${plugin.packageName}`,
          path: [index],
        });
      }
      seen.add(plugin.packageName);
    }
  });
```

Add `plugins: PluginsInputSchema` to `ConfigSchema`. Keep the existing providers record transform unchanged in this task.

- [ ] **Step 6: Run Types tests and regenerate the schema**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/types/_test
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/types build
```

Expected: all Types tests PASS and the generated input JSON Schema contains `plugins`; the active OAuth input remains legacy until Task 11.

- [ ] **Step 7: Commit the config seam**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git add packages/types
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git commit -m "refactor(types): model oauth plugin references" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Implement Descriptor Loading and Staging Registration

**Files:**
- Create: `packages/core/src/plugins/schema.ts`
- Create: `packages/core/src/plugins/config-spec.ts`
- Create: `packages/core/src/plugins/catalog.ts`
- Create: `packages/core/src/plugins/diagnostic.ts`
- Create: `packages/core/src/plugins/registry.ts`
- Create: `packages/core/src/plugins/loader.ts`
- Create: `packages/core/src/plugins/index.ts`
- Create: `packages/core/_test/plugins/registry.test.ts`
- Create: `packages/core/_test/plugins/loader.test.ts`
- Create: `packages/core/_test/plugins/diagnostic.test.ts`
- Create: `packages/core/_test/plugins/schema.test.ts`
- Create: `packages/core/_test/plugins/config-spec.test.ts`
- Create: `packages/core/_test/plugins/catalog.test.ts`
- Modify: `packages/core/package.json`
- Modify: `packages/core/tsconfig.json`
- Modify: `bun.lock`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `PluginDescriptor`, `OAuthAdapter`, `PluginEnablement`, and an injected plugin-secret reader.
- Produces: `PluginRegistry.resolveOAuth(plugin, capability)`, `PluginRegistrySnapshot`, `LoadedPluginState`, and `loadPluginRegistry()`.
- Produces: `parsePluginSchema(schema, value)`, `PluginSchemaContractError`, `validateConfigSpec(value)`, `validateModelCatalog(value)`, `DiagnosticFactory`, redacted plugin logging, and `PluginSecretReader`.
- Leaves embedded definitions injectable until Tasks 10 and 11 add the two real built-ins.

- [ ] **Step 1: Write failing registry and loader tests**

Cover these exact cases:

```ts
test("setup throw leaves no staged capabilities", async () => {
  const descriptor = definePlugin((api) => {
    api.oauth.register(fakeAdapter("first"));
    throw new Error("setup failed");
  });
  const snapshot = await loadPluginRegistry({
    enablements: [{ packageName: "@example/broken" }],
    builtIns: [],
    diagnostics: fakeDiagnosticFactory(),
    importPackage: fakeLoader({ "@example/broken": descriptor }),
    logger: () => {},
    secrets: { readPluginSecret: () => undefined },
  });

  expect(snapshot.registry.resolveOAuth("@example/broken", "first")).toBeUndefined();
  expect(snapshot.plugins.get("@example/broken")?.state).toMatchObject({
    status: "failed",
    diagnostic: { code: "PLUGIN_LOAD_FAILED" },
  });
});

test("duplicate capability rejects the whole plugin", async () => {
  const descriptor = definePlugin((api) => {
    api.oauth.register(fakeAdapter("default"));
    api.oauth.register(fakeAdapter("default"));
  });
  const snapshot = await loadPluginRegistry({
    enablements: [{ packageName: "@example/duplicate" }],
    builtIns: [],
    diagnostics: fakeDiagnosticFactory(),
    importPackage: fakeLoader({ "@example/duplicate": descriptor }),
    logger: () => {},
    secrets: { readPluginSecret: () => undefined },
  });
  expect(snapshot.registry.oauthCapabilities()).toHaveLength(0);
});
```

Also test invalid default export, apiVersion mismatch, options schema failure, adapter shape failure, non-positive TTL, missing cached package, import timeout, setup timeout with a sealed staging registry, setup rerun for each snapshot, and descriptor import caching by `packageName@version`. A manually configured built-in identity must resolve to the embedded descriptor exactly once and never touch cache/import. Any descriptor without an options spec must reject non-empty public options or a retained plugin-scoped secret; this rule applies equally to built-ins and third parties.

In `catalog.test.ts`, cover a valid six-modality catalog plus missing modality arrays, blank IDs, duplicate IDs within one modality, non-string display names, cyclic metadata, functions, `bigint`, and non-finite numbers.

In `schema.test.ts`, use `zod` imported from `@aio-proxy/plugin-sdk` to cover defaults/transforms, an async refinement, normalized Zod issues containing only message/path, a malformed schema object, and a validator that throws. Assert contract failures never expose the input value or raw cause.

In `config-spec.test.ts`, cover every field type plus blank/duplicate keys, blank labels, malformed `when`, a condition referencing an unknown key, duplicate select values, non-JSON defaults, a schema created with the SDK `zod`, and an object without callable `safeParseAsync`/`safeParse` methods.

In `diagnostic.test.ts`, prove public diagnostics never contain a supplied bearer token, access/refresh token, authorization code, PKCE verifier, state, URL query, raw callback URL, cause, or stack. Include an arbitrary third-party secret value embedded in both error message and stack. Prove the local log representation retains error name and redacted stack/message for debugging without that value.

- [ ] **Step 2: Run the loader tests to verify they fail**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins/registry.test.ts packages/core/_test/plugins/loader.test.ts packages/core/_test/plugins/diagnostic.test.ts packages/core/_test/plugins/schema.test.ts packages/core/_test/plugins/config-spec.test.ts packages/core/_test/plugins/catalog.test.ts
```

Expected: FAIL because the host loader and registry do not exist.

- [ ] **Step 3: Implement SDK Zod schema validation**

`parsePluginSchema` must call and await `schema.safeParseAsync(value)` so sync schemas, transforms, and async refinements share one path. Return:

```ts
export type PluginSchemaValidation<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly issues: readonly {
        readonly message: string;
        readonly path: readonly (string | number)[];
      }[];
    };

export function isPluginZodSchema(value: unknown): value is ZodType<unknown>;
export async function parsePluginSchema<T>(
  schema: ZodType<T>,
  value: unknown,
): Promise<PluginSchemaValidation<T>>;
```

Before use, `isPluginZodSchema()` requires a non-null object with callable `safeParse()` and `safeParseAsync()` methods. Normalize each ordinary Zod issue to only `message` and a JSON-safe `(string | number)[]` path; replace any unexpected path segment with the fixed string `"<unknown>"`, and never retain the issue input or raw schema error. A malformed schema, thrown validator, or malformed parse result throws a `PluginSchemaContractError` with a fixed message and no `cause`. Do not use `instanceof`, because independently cached plugin packages may resolve another compatible SDK/Zod module instance. ProviderV4 validation is deliberately deferred to Task 11, where runtime creation first consumes it.

`validateConfigSpec()` must validate the Zod schema member and an array of untrusted field records. Require trimmed non-empty unique keys and labels; exact field types `text|secret|number|boolean|select|json`; `when.key` to reference a previously declared field; JSON-safe defaults; and unique primitive values for a non-empty select option list. Reject unknown field types before any CLI prompt is invoked. Return the typed spec plus a `ReadonlySet<string>` of secret keys so loader/login/form code shares one interpretation.

Implement `validateModelCatalog(value)` in `catalog.ts`. It must require all six modality arrays, return a normalized `ModelCatalog`, reject duplicate IDs within a modality, and accept metadata only when this recursive predicate succeeds:

```ts
function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : (prototype === Object.prototype || prototype === null) &&
      Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}
```

Each descriptor must have a trimmed non-empty `id`, optional string `displayName`, and optional valid JSON metadata. Throw `ModelCatalogValidationError` with modality/index/path only; never include metadata values.

Define the host-owned diagnostic boundary in `diagnostic.ts`:

```ts
export type DiagnosticContext = {
  readonly plugin?: string;
  readonly capability?: string;
  readonly providerId?: string;
};

export type DiagnosticFactory = (
  code: DiagnosticCode,
  options: DiagnosticContext & {
    readonly retryable: boolean;
    readonly suggestedCommand?: string;
  },
) => Diagnostic;

export type PluginLogSink = (entry: {
  readonly event: string;
  readonly code: DiagnosticCode;
  readonly context: DiagnosticContext;
  readonly error: { readonly name: string; readonly message: string; readonly stack?: string };
}) => void;

export type PluginErrorRedaction = {
  readonly secretValues?: readonly string[];
};
```

Core functions receive `DiagnosticFactory` from CLI/server; the adapters build localized summaries through `packages/i18n`, so Core never hardcodes user-facing copy. `redactPluginError(error, redaction)` first replaces every non-empty value in `redaction.secretValues` (longest first), then strips URL queries and masks bearer values plus fields named `access_token`, `refresh_token`, `authorization_code`, `code`, `code_verifier`, `state`, `accessToken`, and `refreshToken` before invoking `PluginLogSink`. Callers pass plugin/account secret field values, authorization code/state/PKCE values when available, and, for credential operations, string leaves from the opaque credential snapshot. Never log raw options/credential objects or attach the raw `cause` to `Diagnostic`.

- [ ] **Step 4: Implement atomic staging and package loading**

Validate descriptor-level `metadata.options` with `validateConfigSpec()` before setup. The registry stores capabilities by `${plugin}\0${adapter.id}`. A plugin-specific staging object validates `adapter.id` with the shared `CapabilityIdSchema` and requires it to be unique, then requires non-empty `label`, a validated `account.options` ConfigSpec, a Zod `credentials` schema with callable `safeParse()`/`safeParseAsync()`, callable `login`, `catalog.discover`, and `createRuntime`, plus either `{ kind: "static" }` or `{ kind: "ttl", ttlMs: positive finite integer }`. It only copies its map into the committed registry after setup resolves.

Use this public host shape:

```ts
export type PluginRegistry = {
  readonly resolveOAuth: (plugin: string, capability: string) => OAuthAdapter | undefined;
  readonly oauthCapabilities: () => readonly {
    readonly plugin: string;
    readonly capability: string;
    readonly adapter: OAuthAdapter;
  }[];
};

export type BuiltInPluginDefinition = {
  readonly packageName: string;
  readonly version: string;
  readonly descriptor: PluginDescriptor<unknown>;
};

export type PluginPackageImporter = (input: {
  readonly packageName: string;
  readonly version: string;
  readonly entrypoint: string;
  readonly attempt: string;
}) => Promise<unknown>;

export type LoadedPluginState = {
  readonly packageName: string;
  readonly version?: string;
  readonly builtIn: boolean;
  readonly state: PluginState;
};

export type PluginRegistrySnapshot = {
  readonly registry: PluginRegistry;
  readonly plugins: ReadonlyMap<string, LoadedPluginState>;
};

export type PluginSecretReader = {
  readonly readPluginSecret: (plugin: string) => unknown | undefined;
};

export type LoadPluginRegistryOptions = {
  readonly enablements: readonly PluginEnablement[];
  readonly builtIns: readonly BuiltInPluginDefinition[];
  readonly diagnostics: DiagnosticFactory;
  readonly importPackage: PluginPackageImporter;
  readonly logger: PluginLogSink;
  readonly secrets: PluginSecretReader;
};
```

`loadPluginRegistry(options)` takes configured third-party entries, injected built-in definitions, an importer, and the narrow secret reader above. Task 3 tests use an in-memory reader; after Task 4 the concrete adapter is `{ readPluginSecret: (plugin) => repository.readPluginSecret(plugin)?.value }`. Match built-in identities before the third-party branch, collapse a matching manual enablement into that embedded definition, and never inspect cache for it. For third-party entries it calls `findInstalledNpmPackage()` only; it never calls `npmAdd()`. Import the entrypoint with `pathToFileURL()`, require a branded default export, validate exact API version, merge plugin-scoped secrets, reject public config containing a `secret` form key, validate the merged options, and execute setup against staging.

Add `"@aio-proxy/plugin-sdk": "workspace:*"` to Core dependencies. The plugin-host path imports plugin contract types and the public `zod` runtime through that package; Core's existing internal Zod schemas remain separate implementation details, and no second plugin-facing schema abstraction is added.

Cache successful imports by canonical package name and resolved package version. Import each uncached attempt with a host-generated query token on the resolved file URL; this bypasses ESM's cached failed evaluation on a later retry. Delete a failed host cache promise so the next snapshot receives a new attempt token, while successful descriptors continue using the cached object.

Use `PLUGIN_IMPORT_TIMEOUT_MS = 10_000` and `PLUGIN_SETUP_TIMEOUT_MS = 5_000`. Dynamic import cannot be forcibly aborted, so attach terminal rejection handling, mark the plugin failed when the host deadline wins, and never commit its descriptor promise to the successful cache. Seal the staging registry at setup timeout so late `register()` calls cannot mutate or commit it. When `metadata.options` is absent, require both the configured public value and `readPluginSecret()` result to be absent or an empty record before calling `setup(api, undefined)`.

- [ ] **Step 5: Run loader tests and the Core boundary check**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun install
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/core build
```

Expected: tests and build PASS; a missing third-party package returns `PLUGIN_NOT_INSTALLED` without registry/network activity.

- [ ] **Step 6: Commit the plugin host loader**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git add bun.lock packages/core
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git commit -m "feat(core): load staged oauth plugins" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Add the Plugin Vault Repository Alongside Legacy Auth

**Files:**
- Create: `packages/core/src/db/migrations/0004_oauth_plugins.sql`
- Create: `packages/core/src/db/schema/plugin-oauth.ts`
- Create: `packages/core/src/plugins/repository.ts`
- Create: `packages/core/_test/plugins/repository.test.ts`
- Modify: `packages/core/src/db/schema/index.ts`
- Modify: `packages/core/src/db/index.ts`
- Modify generated: `packages/core/src/db/migrations.manifest.ts`

**Interfaces:**
- Produces: `PluginRepository`, `StoredAccount`, `StoredCatalog`, `PendingAccountOperation`, and lease primitives.
- Stores credentials and account secret options in one revisioned account row; plugin-scoped secrets remain separate.
- Preserves request logs, usage tables, and the legacy `auth` table until the final clean-break migration in Task 13.

- [ ] **Step 1: Write failing repository tests**

Tests must prove:

- credential JSON and account secret JSON round-trip without appearing in list summaries;
- `{ plugin, capability, fingerprint }` is unique;
- create/re-login increments credential and runtime revisions; re-login rejects stale `runtimeRevision` but tolerates an intervening credential-only refresh, while token refresh CASes and increments credential revision only;
- deleting an account cascades catalog, lease, and diagnostic;
- credential and catalog diagnostics coexist by code and can be cleared independently;
- revision-conditional plugin secret deletion never deletes an account and refuses to remove a concurrent update;
- pending operation records retain rollback state;
- existing `auth` rows remain readable during the transitional Tasks 4–12.

Use an isolated `openDb({ home })` and inspect `PRAGMA table_info` plus foreign-key behavior.

- [ ] **Step 2: Run the repository test to verify it fails**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins/repository.test.ts
```

Expected: FAIL because the new tables and repository do not exist.

- [ ] **Step 3: Add the migration**

Create `0004_oauth_plugins.sql`:

```sql
CREATE TABLE `plugin_secret` (
  `plugin` text PRIMARY KEY NOT NULL,
  `value_json` text NOT NULL,
  `revision` integer NOT NULL,
  `updated_at` integer NOT NULL
);

CREATE TABLE `oauth_account` (
  `provider_id` text PRIMARY KEY NOT NULL,
  `plugin` text NOT NULL,
  `capability` text NOT NULL,
  `fingerprint` text NOT NULL,
  `options_json` text NOT NULL,
  `secret_json` text NOT NULL,
  `credential_json` text NOT NULL,
  `revision` integer NOT NULL,
  `runtime_revision` integer NOT NULL,
  `label` text,
  `expires_at` integer,
  `updated_at` integer NOT NULL,
  UNIQUE(`plugin`, `capability`, `fingerprint`)
);

CREATE TABLE `oauth_catalog` (
  `provider_id` text PRIMARY KEY NOT NULL,
  `catalog_json` text NOT NULL,
  `refreshed_at` integer NOT NULL,
  FOREIGN KEY (`provider_id`) REFERENCES `oauth_account`(`provider_id`) ON DELETE CASCADE
);

CREATE TABLE `oauth_account_diagnostic` (
  `provider_id` text NOT NULL,
  `code` text NOT NULL,
  `diagnostic_json` text NOT NULL,
  PRIMARY KEY (`provider_id`, `code`),
  FOREIGN KEY (`provider_id`) REFERENCES `oauth_account`(`provider_id`) ON DELETE CASCADE
);

CREATE TABLE `oauth_refresh_lease` (
  `provider_id` text PRIMARY KEY NOT NULL,
  `owner` text NOT NULL,
  `expires_at` integer NOT NULL,
  FOREIGN KEY (`provider_id`) REFERENCES `oauth_account`(`provider_id`) ON DELETE CASCADE
);

CREATE TABLE `oauth_pending_operation` (
  `operation_id` text PRIMARY KEY NOT NULL,
  `provider_id` text NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('create', 'update', 'delete')),
  `target_digest` text NOT NULL,
  `applied_revision` integer NOT NULL,
  `previous_revision` integer,
  `rollback_json` text,
  `created_at` integer NOT NULL
);

CREATE INDEX `oauth_account_fingerprint_idx`
  ON `oauth_account` (`plugin`, `capability`, `fingerprint`);
CREATE INDEX `oauth_pending_created_at_idx`
  ON `oauth_pending_operation` (`created_at`);
CREATE INDEX `oauth_pending_provider_idx`
  ON `oauth_pending_operation` (`provider_id`);
```

Mirror every table in `schema/plugin-oauth.ts` with Drizzle types and cascade foreign keys.

- [ ] **Step 4: Implement the repository API**

Expose:

```ts
export type PluginSecretSnapshot = {
  readonly value: unknown;
  readonly revision: number;
};

export type StoredAccount = {
  readonly providerId: string;
  readonly plugin: string;
  readonly capability: string;
  readonly fingerprint: string;
  readonly options: unknown;
  readonly secrets: unknown;
  readonly credential: unknown;
  readonly revision: number;
  readonly runtimeRevision: number;
  readonly label?: string;
  readonly expiresAt?: number;
  readonly updatedAt: number;
};

export type StoredAccountSummary = Omit<StoredAccount, "options" | "secrets" | "credential">;

export type StoredCatalog = {
  readonly catalog: ModelCatalog;
  readonly refreshedAt: number;
};

export type PendingAccountOperation = {
  readonly operationId: string;
  readonly providerId: string;
  readonly kind: "create" | "update" | "delete";
  readonly targetDigest: string;
  readonly appliedRevision: number;
  readonly previousRevision?: number;
  readonly createdAt: number;
};

export type AccountWrite = {
  readonly providerId: string;
  readonly plugin: string;
  readonly capability: string;
  readonly fingerprint: string;
  readonly options: unknown;
  readonly secrets: unknown;
  readonly credential: unknown;
  readonly label?: string;
  readonly expiresAt?: number;
  readonly catalog:
    | { readonly kind: "replace"; readonly value: StoredCatalog }
    | { readonly kind: "preserve"; readonly diagnostic: Diagnostic }
    | { readonly kind: "missing"; readonly diagnostic: Diagnostic };
};

export type StageAccountOperationInput =
  | { readonly kind: "create"; readonly targetDigest: string; readonly account: AccountWrite }
  | {
      readonly kind: "update";
      readonly targetDigest: string;
      readonly expectedRuntimeRevision: number;
      readonly account: AccountWrite;
    }
  | {
      readonly kind: "delete";
      readonly targetDigest: "absent";
      readonly providerId: string;
      readonly expectedRuntimeRevision: number;
    };

export type PluginRepository = {
  readonly readPluginSecret: (plugin: string) => PluginSecretSnapshot | null;
  readonly writePluginSecret: (
    plugin: string,
    expectedRevision: number | null,
    value: unknown,
  ) => PluginSecretSnapshot;
  readonly deletePluginSecret: (plugin: string, expectedRevision: number) => boolean;
  readonly readAccount: (providerId: string) => StoredAccount | null;
  readonly findAccountByFingerprint: (
    plugin: string,
    capability: string,
    fingerprint: string,
  ) => StoredAccount | null;
  readonly listAccounts: () => readonly StoredAccountSummary[];
  readonly readCatalog: (providerId: string) => StoredCatalog | null;
  readonly writeCatalog: (providerId: string, catalog: ModelCatalog, refreshedAt: number) => void;
  readonly readDiagnostics: (providerId: string) => readonly Diagnostic[];
  readonly writeDiagnostic: (providerId: string, diagnostic: Diagnostic) => boolean;
  readonly clearDiagnostic: (providerId: string, code: DiagnosticCode) => boolean;
  readonly deleteAccount: (providerId: string) => void;
  readonly stageAccountOperation: (input: StageAccountOperationInput) => PendingAccountOperation;
  readonly completeAccountOperation: (operationId: string) => void;
  readonly compensateAccountOperation: (operationId: string) => "compensated" | "superseded";
  readonly finalizeDeleteOperation: (operationId: string) => "deleted" | "superseded";
  readonly listPendingAccountOperations: () => readonly PendingAccountOperation[];
  readonly tryAcquireRefreshLease: (providerId: string, owner: string, now: number, expiresAt: number) => boolean;
  readonly renewRefreshLease: (providerId: string, owner: string, expiresAt: number) => boolean;
  readonly releaseRefreshLease: (providerId: string, owner: string) => void;
  readonly compareAndSwapCredential: (
    providerId: string,
    expectedRevision: number,
    credential: unknown,
    metadata?: { readonly label?: string; readonly expiresAt?: number },
  ) => StoredAccount | null;
};
```

`StoredAccount` and `StoredAccountSummary` expose both `revision` and `runtimeRevision`. `stageAccountOperation()` increments both revisions for create/re-login/account-option changes. Its update path conditions on `expectedRuntimeRevision`, rereads the latest credential revision inside the same SQLite transaction, and snapshots that latest row for rollback; therefore a completed refresh does not invalidate re-login, while another re-login/options edit does. `compareAndSwapCredential()` conditions on and increments only `revision`, preserving `runtimeRevision` so ordinary rotating-token refresh does not invalidate runtime identity.

`PendingAccountOperation.appliedRevision` is an operation-specific CAS token: create/update markers store the applied credential revision used for compensation, while delete markers store the pre-delete `runtimeRevision`. Repository tests must assert both interpretations so finalization never confuses a token refresh with account replacement.

Use short `sqlite.transaction(...).immediate()` blocks only around conditional writes. Never hold a write transaction while awaiting plugin or network code.

- [ ] **Step 5: Generate the migration manifest and run tests**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run build:migrations
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins/repository.test.ts packages/core/_test/open-db-paths.test.ts
```

Expected: tests PASS; the manifest contains `0004_oauth_plugins.sql` with a matching hash, and the legacy `auth` table still exists.

- [ ] **Step 6: Commit the vault repository**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git add packages/core/src/db packages/core/src/plugins/repository.ts packages/core/_test/plugins/repository.test.ts
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git commit -m "feat(core): add oauth plugin vault" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 5: Add High-Level Credential Refresh with Cross-Process Lease

**Files:**
- Create: `packages/core/src/plugins/credential-port.ts`
- Create: `packages/core/_test/plugins/credential-port.test.ts`
- Create: `packages/core/_test/plugins/refresh-lease-child.ts`
- Modify: `packages/core/src/plugins/index.ts`
- Modify: `packages/core/src/plugins/repository.ts`

**Interfaces:**
- Consumes: `PluginRepository`, adapter credential schema, and `CredentialPort`.
- Produces: `createCredentialPort({ providerId, schema, repository, diagnostics, logger, onDiagnosticChanged })`.
- Guarantees: one in-process exchange, one lease owner across processes, schema validation before CAS, and `superseded` after concurrent re-login.

- [ ] **Step 1: Write failing refresh concurrency tests**

Add tests for:

```ts
test("deduplicates concurrent refresh calls in one process", async () => {
  const port = createCredentialPort(fixture);
  const first = await port.read();
  let exchanges = 0;
  const exchange = async () => {
    exchanges += 1;
    await gate;
    return { value: nextCredential };
  };

  const a = port.refresh(first.revision, exchange);
  const b = port.refresh(first.revision, exchange);
  releaseGate();
  const [left, right] = await Promise.all([a, b]);

  expect(exchanges).toBe(1);
  expect(left.snapshot.revision).toBe(right.snapshot.revision);
});
```

Spawn two `refresh-lease-child.ts` processes against one isolated DB. Both request the same revision; exactly one child must print `exchange`, and the other must print `superseded`. Also cover lease expiry after a killed owner, invalid refreshed credentials, re-login winning the CAS while an exchange is running, delivery of the deadline signal, timeout/release when an exchange ignores abort, unchanged `runtimeRevision` on refresh, and one `onDiagnosticChanged` notification only when a diagnostic is written or cleared.

- [ ] **Step 2: Run the refresh tests to verify they fail**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins/credential-port.test.ts
```

Expected: FAIL because the high-level port does not exist.

- [ ] **Step 3: Implement single-flight and lease acquisition**

Use these constants:

```ts
const REFRESH_LEASE_MS = 45_000;
const REFRESH_RENEW_MS = 15_000;
const REFRESH_EXCHANGE_TIMEOUT_MS = 30_000;
const REFRESH_WAIT_TIMEOUT_MS = 60_000;
const REFRESH_POLL_MS = 100;
```

The algorithm is:

```ts
async function refresh(expectedRevision, exchange) {
  return singleFlight(providerId, async () => {
    const owner = `${process.pid}:${crypto.randomUUID()}`;
    await waitForLease(providerId, owner, REFRESH_WAIT_TIMEOUT_MS);
    const renew = setInterval(
      () => repository.renewRefreshLease(providerId, owner, Date.now() + REFRESH_LEASE_MS),
      REFRESH_RENEW_MS,
    );
    try {
      const current = readAndValidate();
      if (current.revision !== expectedRevision) {
        return { status: "superseded", snapshot: current };
      }
      const exchanged = await withDeadline(
        (signal) => exchange(current, signal),
        REFRESH_EXCHANGE_TIMEOUT_MS,
      );
      const validated = await parsePluginSchema(schema, exchanged.value);
      if (!validated.ok) {
        throw new CredentialValidationError(validated.issues);
      }
      const updated = repository.compareAndSwapCredential(
        providerId,
        expectedRevision,
        validated.value,
        exchanged.metadata,
      );
      if (updated === null) {
        return { status: "superseded", snapshot: readAndValidate() };
      }
      if (repository.clearDiagnostic(providerId, "CREDENTIAL_REFRESH_FAILED")) onDiagnosticChanged();
      return { status: "updated", snapshot: toSnapshot(updated) };
    } finally {
      clearInterval(renew);
      repository.releaseRefreshLease(providerId, owner);
    }
  });
}
```

`withDeadline()` creates an `AbortController`, passes its signal to the callback, aborts it at 30 seconds, and also rejects the host await so a plugin that ignores abort cannot retain the lease forever. `waitForLease()` sleeps with bounded jitter, rereads the account after another owner releases or expires, and never calls `exchange` when revision has already changed. Record `CREDENTIAL_REFRESH_FAILED` without serializing the credential or original error into the safe diagnostic.

In the error path, call `onDiagnosticChanged()` only when `repository.writeDiagnostic()` returns true. On success, call it only when `clearDiagnostic()` returns true. The server callback requests a serialized diagnostic-only snapshot rebuild, while CLI callers use a no-op.

- [ ] **Step 4: Run single-process and child-process tests**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins/credential-port.test.ts
```

Expected: PASS; the two-process test observes one upstream exchange.

- [ ] **Step 5: Commit refresh coordination**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git add packages/core/src/plugins packages/core/_test/plugins
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git commit -m "feat(core): coordinate oauth credential refresh" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 6: Implement Host-Owned Device and Loopback Authorization

**Files:**
- Create: `packages/cli/src/plugin-commands/authorization.ts`
- Create: `packages/cli/src/plugin-commands/loopback.ts`
- Create: `packages/cli/_test/plugin-authorization.test.ts`
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/tsconfig.json`
- Modify: `bun.lock`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`

**Interfaces:**
- Consumes: SDK `AuthorizationPort`, `DeviceCodePresentation`, and `LoopbackRequest`.
- Produces: `createCliAuthorizationPort(deps)` and `runLoopbackAuthorization(request, deps)`.
- Guarantees: listener-before-browser, full callback URL validation, first valid result wins, and listener cleanup on every path.

- [ ] **Step 1: Write failing device and loopback tests**

Tests must cover:

- complete verification URL is opened and always printed;
- device and authorization URLs reject non-HTTP(S) schemes before browser invocation;
- user code copy success/failure is reported without treating failure as auth failure;
- listener binds before `authorizationUrl({ redirectUri })` and browser open;
- fixed `http://localhost:1455/auth/callback`;
- dynamic port allocation;
- automatic callback success;
- manual full callback URL success;
- auto/manual race resolves once;
- scheme, hostname, port, path, and state mismatch;
- an OAuth `error` carrying the wrong state is rejected without settling, while the same error with the expected state ends the session;
- an invalid automatic callback cannot settle the session and a later valid callback still succeeds;
- invalid manual input is reported and can be retried until success, timeout, or abort;
- missing code, standard OAuth `error`, timeout, abort, duplicate callback;
- fixed-port bind failure requires explicit manual-only confirmation;
- server stops after success and every failure.

Use local `Bun.serve`, fake Inquirer functions, fake browser/clipboard functions, and `AbortController`; do not contact an OAuth endpoint.

- [ ] **Step 2: Run the authorization test to verify it fails**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/cli/_test/plugin-authorization.test.ts
```

Expected: FAIL because the authorization port does not exist.

- [ ] **Step 3: Implement device-code presentation**

`createCliAuthorizationPort()` must expose:

```ts
export type CliAuthorizationDeps = {
  readonly copy: {
    readonly copiedDeviceCode: string;
    readonly deviceCode: (code: string) => string;
    readonly openedAuthorizationPage: string;
    readonly successHtml: string;
  };
  readonly openBrowser: (url: string) => boolean;
  readonly copyToClipboard: (value: string) => boolean;
  readonly print: (message: string) => void;
  readonly readManualCallbackUrl: (authorizationUrl: string, signal: AbortSignal) => Promise<string>;
  readonly confirmManualOnly: (redirectUri: string) => Promise<boolean>;
  readonly signal: AbortSignal;
  readonly now?: () => number;
};

function requireHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AuthorizationUrlInvalidError();
  }
  return url;
}

export function createCliAuthorizationPort(deps: CliAuthorizationDeps): AuthorizationPort {
  return {
    async presentDeviceCode(input) {
      const url = requireHttpUrl(input.url);
      if (deps.copyToClipboard(input.userCode)) {
        deps.print(deps.copy.copiedDeviceCode);
      } else {
        deps.print(deps.copy.deviceCode(input.userCode));
      }
      if (deps.openBrowser(url.href)) {
        deps.print(deps.copy.openedAuthorizationPage);
      }
      deps.print(url.href);
      if (input.instructions !== undefined) {
        deps.print(input.instructions);
      }
    },
    loopback: (input) => runLoopbackAuthorization(input, deps),
  };
}
```

Build the default `copy` object from `packages/i18n`; tests inject deterministic English copy. The account-login host creates one deadline controller and passes the same signal both as `OAuthLoginContext.signal` and `CliAuthorizationDeps.signal`, so timeout/cancel aborts browser waiting, manual input, and listener work together.

Add `"@aio-proxy/plugin-sdk": "workspace:*"` to `packages/cli/package.json` and its project reference before importing the authorization contracts. Task 7 reuses the same direct dependency for ConfigSpec rendering.

- [ ] **Step 4: Implement the loopback session**

Use a single `settle()` guard and these constants:

```ts
const LOOPBACK_TIMEOUT_MS = 10 * 60_000;
```

Require non-empty state, a port of `"dynamic"` or integer `1..65535`, a slash-prefixed path without query/fragment, and an `authorizationUrl()` result using `http:` or `https:` before opening the browser. Build the expected redirect URI from the actual bound port. Bind `127.0.0.1` even when the registered callback hostname is `localhost`. Validate the callback against the expected URL:

```ts
function parseCallback(
  raw: string,
  expectedRedirectUri: string,
  expectedState: string,
): { readonly code: string } {
  const callback = new URL(raw);
  const expected = new URL(expectedRedirectUri);
  if (
    callback.protocol !== expected.protocol ||
    callback.hostname !== expected.hostname ||
    callback.port !== expected.port ||
    callback.pathname !== expected.pathname
  ) {
    throw new LoopbackCallbackMismatchError();
  }
  if (callback.searchParams.get("state") !== expectedState) {
    throw new LoopbackStateMismatchError();
  }
  const oauthError = callback.searchParams.get("error");
  if (oauthError !== null) {
    throw new LoopbackOAuthError(oauthError);
  }
  const code = callback.searchParams.get("code");
  if (code === null || code.length === 0) {
    throw new LoopbackCodeMissingError();
  }
  return { code };
}
```

Never include the raw callback URL, code, state, or query in a public error. The HTTP listener returns 404 for a wrong path and 400 for malformed URI/state/code without settling the authorization session; state is checked before interpreting `error`, so only a standard OAuth error carrying the expected state may call `settle()`. Return `deps.copy.successHtml` with an HTML content type after success. Manual parsing reports the same safe typed error and prompts again. Race the automatic callback promise with the retrying manual input promise only when `allowManualCallbackUrl` is true and stdin is interactive. Compose the losing-path controller with `deps.signal`; abort either source immediately, and close the listener in `finally`.

- [ ] **Step 5: Run authorization tests**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun install
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run i18n:compile
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/cli/_test/plugin-authorization.test.ts
```

Expected: PASS, including fixed-port, manual fallback, validation, race, abort, and cleanup cases.

- [ ] **Step 6: Commit host authorization**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git add bun.lock packages/cli packages/i18n
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git commit -m "feat(cli): host oauth authorization flows" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 7: Render ConfigSpec and Add Plugin Lifecycle Commands

**Files:**
- Create: `packages/core/src/plugins/config-file.ts`
- Create: `packages/core/src/plugins/builtins.ts`
- Create: `packages/core/_test/plugins/config-file.test.ts`
- Create: `packages/core/_test/plugins/config-lock-child.ts`
- Create: `packages/cli/src/plugin-commands/form.ts`
- Create: `packages/cli/src/plugin-commands/plugin.ts`
- Create: `packages/cli/src/plugin-commands/index.ts`
- Create: `packages/cli/_test/plugin-form.test.ts`
- Create: `packages/cli/_test/plugin-commands.test.ts`
- Modify: `packages/core/src/npm.ts`
- Modify: `packages/core/src/npm-list.ts`
- Modify: `packages/core/src/plugins/index.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`

**Interfaces:**
- Produces: `renderConfigSpec()`, `AtomicConfigFile`, `pluginAdd`, `pluginList`, `pluginConfig`, `pluginRemove`, and `pluginPrune`.
- Produces: `removeNpmPackageCache(packageName)`.
- Produces: the reserved `BUILT_IN_PLUGIN_PACKAGE_NAMES` identity set; Task 11 adds embedded descriptors to the same module.
- Consumes: descriptor metadata, staging validation, plugin vault revisions, and the existing isolated npm cache.

- [ ] **Step 1: Write failing ConfigSpec renderer tests**

Create one ConfigSpec containing all field types and assert:

```ts
expect(result).toEqual({
  publicValues: {
    endpoint: "https://example.test",
    retries: 3,
    enabled: true,
    region: "us",
    advanced: { mode: "strict" },
  },
  secrets: { token: "secret-value" },
});
```

Also test:

- a `when: { key, equals }` field is skipped when false;
- schema issues map to field keys;
- existing non-secret values are supplied as prompt defaults for plugin config and explicit account re-login;
- aborting the supplied signal cancels the active prompt and returns no partial values;
- blank existing secret retains the old value;
- `clearSecrets: ["token"]` removes it;
- malformed number and JSON are rejected before schema validation;
- plugin public options never contain secret keys.

In `config-file.test.ts`, spawn two child processes that update different keys in one config and assert neither update is lost. Kill a lock owner and prove stale-lock recovery; assert file mode and trailing newline survive success and rollback; and prove a failed verify callback restores the exact original bytes only while the same lock is held.

- [ ] **Step 2: Write failing plugin command tests**

Use a fake registry package in the isolated cache. Assert:

- `plugin add` refuses non-TTY without `--yes`;
- trust confirmation occurs before npm import;
- failed import/schema/setup leaves `plugins` config unchanged;
- successful add writes string form for no public options and tuple form otherwise;
- built-in add is a successful `already built in` no-op with no npm access;
- list includes built-ins and configured third parties with state;
- list output contains neither plugin public options nor vault secrets;
- config preserves blank secrets and supports explicit clear;
- remove preserves plugin secret by default;
- `--purge-secrets` requires a second confirmation and removes only plugin secret;
- failed config replacement restores the previous plugin secret only when the just-written revision still matches, never overwriting a concurrent secret update;
- prune removes only cache entries absent from both `plugins` and configured AI SDK provider package names.

- [ ] **Step 3: Run renderer and command tests to verify they fail**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/cli/_test/plugin-form.test.ts packages/cli/_test/plugin-commands.test.ts
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins/config-file.test.ts
```

Expected: FAIL because the locked atomic config helper, renderer, and plugin commands do not exist.

- [ ] **Step 4: Implement the atomic config helper**

Expose:

```ts
export type AtomicConfigFile = {
  readonly read: () => Promise<Record<string, unknown>>;
  readonly transaction: <T>(
    mutate: (
      current: Record<string, unknown>,
    ) => Promise<{ readonly next: Record<string, unknown>; readonly result: T }>,
    options?: {
      readonly validateCandidate?: (candidate: Record<string, unknown>) => void;
      readonly verify?: (candidate: Record<string, unknown>) => Promise<void>;
    },
  ) => Promise<T>;
  readonly replace: (
    mutate: (current: Record<string, unknown>) => Record<string, unknown>,
    options?: {
      readonly validateCandidate?: (candidate: Record<string, unknown>) => void;
      readonly verify?: (candidate: Record<string, unknown>) => Promise<void>;
    },
  ) => Promise<void>;
  readonly providerEntry: (providerId: string) => Promise<unknown | undefined>;
  readonly providerEntryDigest: (providerId: string) => Promise<string | null>;
};
```

`transaction()` acquires `${path}.lock` with exclusive create before reading. Use `CONFIG_LOCK_WAIT_MS = 15_000`, `CONFIG_LOCK_STALE_MS = 60_000`, `CONFIG_LOCK_HEARTBEAT_MS = 10_000`, and 50 ms bounded-jitter polling; the lock record contains PID, random owner ID, and creation time, while the owner refreshes file mtime as its heartbeat. On Darwin/Linux, reclaim when the owner PID is gone or the heartbeat is older than the stale window, which also handles PID reuse. While holding the lock, read original bytes/mode and await the local-only mutation callback. If it returns the exact `current` object as `next`, treat the operation as a locked read/short SQLite transaction and skip validation, rewrite, and `verify`. Otherwise validate `next`, write `${path}.${pid}.${owner}.tmp` with a final newline, chmod it, and atomically rename. If `verify` rejects, restore the exact original bytes/mode before releasing the lock; always stop the heartbeat and remove temp files in `finally`, and unlink the lock only after rereading the same owner ID. `replace()` is the synchronous-mutation convenience wrapper over `transaction()`. Mutation callbacks may perform short SQLite work but must never prompt, import a package, or call the network. Use a stable recursively key-sorted JSON representation and SHA-256 for provider entry digests.

- [ ] **Step 5: Implement all form field renderers**

Use one exhaustive switch:

```ts
switch (field.type) {
  case "text":
    value = await prompts.input(...);
    break;
  case "secret":
    value = await prompts.password(...);
    break;
  case "number": {
    const raw = (await prompts.input(...)).trim();
    value = raw === "" ? undefined : Number(raw);
    if (value !== undefined && !Number.isFinite(value)) throw new FormNumberInvalidError(field.key);
    break;
  }
  case "boolean":
    value = await prompts.confirm(...);
    break;
  case "select":
    value = await prompts.select(...);
    break;
  case "json": {
    const raw = (await prompts.input(...)).trim();
    try {
      value = raw === "" ? undefined : JSON.parse(raw);
    } catch {
      throw new FormJsonInvalidError(field.key);
    }
    break;
  }
  default:
    assertNever(field);
}
```

`renderConfigSpec()` accepts `{ currentPublicValues, currentSecrets, clearSecrets, signal }`; create flows pass empty records, while plugin config and explicit account re-login pass their current values. Forward `signal` to every Inquirer prompt so login cancellation/deadline cannot leave a prompt running. Use current non-secret values as prompt defaults only when the field is visible. Do not add `undefined` values to the collected record; this lets schema defaults and optional fields work. After collecting visible fields, split keys whose descriptor type is `secret`, apply retain/clear semantics, merge for Zod validation through `parsePluginSchema()`, and return the validated object split back into public values and secrets.

- [ ] **Step 6: Implement plugin add/config/remove/prune**

The add order is fixed:

```ts
confirm trust
-> npmAdd
-> import and validate descriptor
-> render/merge plugin ConfigSpec
-> validate setup in a staging registry
-> CAS-write plugin secret
-> atomically write plugins config
-> restore the prior plugin secret if config replacement fails
```

After prompt/import/setup completes, enter `AtomicConfigFile.transaction()` and perform the short plugin-secret CAS inside its mutation callback before returning the next config. The secret write returns its applied revision. Compensation is a revision CAS: restore/delete only while that applied revision is still current; if another process already updated the secret, preserve the newer value and fail safely. A crash between secret and config commits may leave an unreferenced plugin secret, which is intentionally preserved by the v1 removal policy and can be corrected by `plugin config` or explicit purge.

Create `core/src/plugins/builtins.ts` with only the stable identity set in this task:

```ts
export const BUILT_IN_PLUGIN_PACKAGE_NAMES = [
  "@aio-proxy/plugin-github-copilot",
  "@aio-proxy/plugin-openai-chatgpt",
] as const;
```

For either reserved name, return before `npmAdd()`. Command tests inject fake built-in definitions for list/state assertions; the production descriptor binding is added in Task 11 after both packages exist.

Store plugin config as:

```ts
const entry =
  Object.keys(publicValues).length === 0
    ? packageName
    : [packageName, publicValues];
```

`plugin remove` rejects built-ins. It removes only the config enablement; `--purge-secrets` snapshots the current secret revision and calls revision-conditional `deletePluginSecret()` only after a successful config replacement. `plugin prune` computes the used package set from third-party plugin enablements plus every raw provider record with `kind === "ai-sdk"` and a valid package-name string, even when another field makes that provider unavailable; then it calls `removeNpmPackageCache()` for all other cache directories. This conservative scan prevents prune from deleting a package still named by a broken config entry.

- [ ] **Step 7: Wire Commander and localized copy**

Add:

```ts
const plugin = program.command("plugin").description(m.cli_plugin_description());
plugin.command("add <package>").option("--yes").option("--registry <url>").action(pluginAdd);
plugin.command("list").action(pluginList);
plugin.command("config <package>").option("--clear-secret <key...>").action(pluginConfig);
plugin.command("remove <package>").option("--purge-secrets").option("--yes").action(pluginRemove);
plugin.command("prune").option("--yes").action(pluginPrune);
```

Add complete English and Simplified Chinese messages for command descriptions, trust warning, built-in no-op, secret retention/purge, prune summary, validation errors, and every plugin diagnostic code reachable from CLI commands. Build the CLI `DiagnosticFactory` from those messages and pass only safe package/capability/provider IDs as interpolation values. Run the root `i18n:compile` script.

- [ ] **Step 8: Run plugin command tests and builds**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run i18n:compile
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/cli/_test/plugin-form.test.ts packages/cli/_test/plugin-commands.test.ts
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins/config-file.test.ts
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/cli test:unit
```

Expected: all command tests PASS.

- [ ] **Step 9: Commit plugin lifecycle commands**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git add packages/core packages/cli packages/i18n
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git commit -m "feat(cli): manage oauth plugins" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 8: Implement the Account Login Transaction and Crash Recovery

**Files:**
- Create: `packages/core/src/plugins/provider-id.ts`
- Create: `packages/core/src/plugins/account-login.ts`
- Create: `packages/core/_test/plugins/provider-id.test.ts`
- Create: `packages/core/_test/plugins/account-login.test.ts`
- Create: `packages/cli/src/plugin-commands/provider-login.ts`
- Create: `packages/cli/_test/provider-plugin-login.test.ts`
- Modify: `packages/core/src/plugins/index.ts`
- Modify: `packages/core/src/plugins/config-file.ts`

**Interfaces:**
- Produces: `resolveProviderId()`, `loginOAuthAccount({ targetProviderId? })`, `deleteOAuthAccount()`, `recoverPendingAccountOperations(options): Promise<{ nextRunAt?: number }>`, and generic `providerLogin`.
- Consumes: committed registry, rendered account ConfigSpec, CLI authorization port, repository, atomic config file, `DiagnosticFactory`, and redacted logger.
- Commits: account/provider one-to-one identity with durable marker and conditional compensation.
- Guarantees: only explicit `--provider <id>` is a re-login; new login never silently overwrites an existing fingerprint.
- Stages: the generic CLI function and tests, but leaves the existing public vendor command wired until Task 11 completes the schema/runtime cutover.

- [ ] **Step 1: Write failing deterministic Provider ID tests**

Test:

- free normalized `suggestedKey` is used directly;
- an existing namespaced fingerprint returns `status: "existing"` with its Provider ID;
- a conflicting key appends the first 8 hex characters of SHA-256 over `${plugin}\0${capability}\0${fingerprint}`;
- injected prefix collisions extend to 12, 16, and then 20 characters;
- the result is independent of provider iteration order;
- blank/invalid suggested keys normalize to `oauth`.

- [ ] **Step 2: Write failing login transaction tests**

Cover:

- credential schema failure performs no write;
- blank/non-string fingerprint, malformed suggested key/label, and non-finite expiry perform no write;
- a new login whose fingerprint already exists performs no write and reports the canonical `provider login --provider <id>` command only when that structured entry still exists; an orphan/delete-pending row reports cleanup-pending;
- explicit re-login preloads existing public options and account secrets before adapter login, fixes the Provider ID, and rejects a returned fingerprint mismatch;
- explicit re-login with a missing config entry performs no network call and reports cleanup-pending;
- explicit re-login cancels an older delete marker only when the structured entry has already been re-added;
- explicit re-login requires both a structured config entry and its account row; an orphan/delete-pending row without an entry reports cleanup-pending instead of being resurrected;
- a credential-only refresh during re-login does not invalidate the target, while a concurrent re-login/account-options update does;
- two concurrent new logins recheck under the file lock, preserve unrelated provider edits, and leave one committed account while the loser receives the duplicate-fingerprint error;
- initial discovery success stores catalog;
- initial discovery failure stores account/config plus `CATALOG_UNAVAILABLE`;
- re-login discovery failure preserves last-known-good catalog;
- config write failure deletes a newly created account;
- config write failure restores an updated account only when applied revision still matches;
- re-login authorization/validation failure preserves the old revision;
- marker is completed when target provider digest is present;
- delete marker records `runtimeRevision` and finalizes account/catalog/secret deletion only after the provider entry is still absent under the config lock and the injected server drain predicate returns true;
- a credential-only refresh while the old snapshot drains does not block deletion;
- a provider entry re-added or an account re-created/re-logged-in before delete recovery supersedes deletion and preserves the account;
- expired marker with a different digest compensates;
- non-expired marker is untouched;
- recovery reports the earliest pending-marker/orphan grace deadline for host rescheduling;
- CLI recovery processes create/update markers only; server recovery leaves delete/orphan rows intact while `canDeleteAccount(providerId)` is false and schedules a bounded retry;
- superseded compensation preserves newer data and writes a safe diagnostic;
- unreferenced accounts older than the 30-minute grace are deleted, while newer rows and every row with a pending marker are preserved.

- [ ] **Step 3: Run transaction tests to verify they fail**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins/provider-id.test.ts packages/core/_test/plugins/account-login.test.ts packages/cli/_test/provider-plugin-login.test.ts
```

Expected: FAIL because provider ID allocation, transaction, recovery, and generic login do not exist.

- [ ] **Step 4: Implement deterministic Provider ID allocation**

Use:

```ts
export function normalizeSuggestedKey(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  return normalized.length === 0 ? "oauth" : normalized;
}
```

Check fingerprint existence before key availability. On collision, calculate one SHA-256 digest and try suffix lengths `8, 12, 16, ... 64`. Throw a typed collision error only if the full hash is already owned by a different account.

Return a discriminated result rather than hiding reuse:

```ts
export type ProviderIdResolution =
  | { readonly status: "existing"; readonly providerId: string }
  | { readonly status: "new"; readonly providerId: string };
```

The create-login caller converts `status: "existing"` into `ProviderAccountAlreadyExistsError`; the pure allocator test still proves deterministic lookup and lets the CLI include the exact existing ID in its guidance.

- [ ] **Step 5: Implement login and discovery before persistence**

Use `LOGIN_TIMEOUT_MS = 20 * 60_000`. `loginOAuthAccount()` receives an optional `targetProviderId`. Before network work, the CLI/core boundary behaves as follows:

- create one deadline controller and bind the same signal to ConfigSpec prompts, `OAuthLoginContext.signal`, and the CLI AuthorizationPort;
- without a target, resolve `{ plugin, capability }`, render an empty/default account form with that signal, and treat the operation as create;
- with a target, enter a no-rewrite `AtomicConfigFile.transaction()` and require both its structured raw provider entry and account row. Infer `{ plugin, capability }` from the entry, require the account to match it, and cancel an older delete marker only when that entry is present again. Capture `runtimeRevision`/fingerprint and pass current public options plus secret values and the signal to the renderer; an explicitly supplied capability must match the target. A missing entry returns `AccountCleanupPendingError`;

The host then:

1. validates merged account options through `parsePluginSchema()`;
2. runs `adapter.login()` with the bound CLI authorization port;
3. validates a trimmed non-empty fingerprint, string suggested key, optional string label, optional finite integer expiry, and returned credentials through `parsePluginSchema()`;
4. creates an in-memory revision-0 CredentialPort whose `refresh()` validates exchanged credentials and increments only its local revision;
5. attempts `adapter.catalog.discover()` with that port under a 30-second child deadline composed with the outer login signal and validates it with `validateModelCatalog()`;
6. rereads the in-memory credential in case discovery refreshed it;
7. enters `AtomicConfigFile.transaction()` after all network work;
8. rereads the target entry, account `runtimeRevision`, fingerprint index, pending operations, and current raw provider entries under the file lock; a missing target or delete marker appearing after preflight makes the re-login fail before writes;
9. for create, throws `ProviderAccountAlreadyExistsError(existingProviderId)` if the fingerprint now exists; for re-login, requires the target account/runtime revision to remain current, requires any re-added entry to match the account capability, and requires the returned fingerprint to equal the stored fingerprint. A credential-only refresh may advance `revision` and is allowed; the re-login write then advances both revisions, so any older refresh CAS loses;
10. allocates a deterministic Provider ID only for create, or fixes it to `targetProviderId` for re-login;
11. builds a structured provider entry from the locked current value, preserving current routing fields for the explicit re-login target;
12. stages the durable repository transaction and returns the next config from the locked callback.

The provider entry is:

```ts
{
  kind: "oauth",
  plugin,
  capability,
  ...(Object.keys(publicOptions).length === 0 ? {} : { options: publicOptions }),
  enabled: existingEntry?.enabled ?? true,
  ...(existingEntry?.weight === undefined ? {} : { weight: existingEntry.weight }),
  ...(existingEntry?.name === undefined ? {} : { name: existingEntry.name }),
  ...(existingEntry?.alias === undefined ? {} : { alias: existingEntry.alias })
}
```

- [ ] **Step 6: Implement pending marker commit and recovery**

Use:

```ts
export const PENDING_OPERATION_TTL_MS = 30 * 60_000;
```

Within the file-locked callback, one SQLite transaction in `stageAccountOperation()` writes the marker, new account revision/runtime revision, account secrets, catalog if available, clears `CREDENTIAL_REFRESH_FAILED`, and clears or upserts `CATALOG_UNAVAILABLE` according to discovery. The callback returns the next config and operation ID to `AtomicConfigFile.transaction()`. On successful rename remove the marker; on validation/write failure immediately call conditional compensation. Recheck fingerprint, target runtime revision, and Provider ID inside the lock so two concurrent logins cannot overwrite a newly created provider or stale routing fields.

During Tasks 8–10, validate the target structured entry without activating it in the server parser:

```ts
function validateStagedOAuthWrite(candidate: Record<string, unknown>): void {
  const providers = candidate.providers;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
    ConfigSchema.parse(candidate);
    return;
  }
  const record = providers as Record<string, unknown>;
  const legacyProviders: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(record)) {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Reflect.get(value, "kind") === "oauth" &&
      !Object.hasOwn(value, "vendor")
    ) {
      OAuthPluginProviderSchema.parse({ ...value, id });
    } else {
      legacyProviders[id] = value;
    }
  }
  ConfigSchema.parse({ ...candidate, providers: legacyProviders });
}
```

Pass this function as `AtomicConfigFile.transaction()`'s `validateCandidate` option. It validates every staged structured OAuth entry plus every pre-existing legacy/API/AI SDK entry, so direct tests can create more than one plugin account before cutover. The generic command remains unreachable from Commander until Task 11, preventing users from leaving a running pre-cutover server with a structured entry.

Expose the recovery options exactly:

```ts
export type RecoverPendingAccountOperationsOptions =
  | { readonly mode: "cli"; readonly now?: () => number }
  | {
      readonly mode: "server";
      readonly canDeleteAccount: (providerId: string) => boolean;
      readonly now?: () => number;
    };
```

Recovery runs its raw-config check and any short repository mutation inside a no-rewrite `AtomicConfigFile.transaction()` by returning the exact `current` object. It compares `Date.now() - createdAt` and the current provider entry digest:

```ts
const ABSENT_PROVIDER_DIGEST = "absent";
if (options.mode === "cli" && operation.kind === "delete") continue;
if (age < PENDING_OPERATION_TTL_MS) continue;
const observedDigest = currentDigest ?? ABSENT_PROVIDER_DIGEST;
if (observedDigest === operation.targetDigest) {
  if (operation.kind === "delete") {
    if (options.mode !== "server") continue;
    if (!options.canDeleteAccount(operation.providerId)) {
      nextRunAt = Math.min(nextRunAt, now + RECOVERY_DRAIN_RETRY_MS);
      continue;
    }
    repository.finalizeDeleteOperation(operation.operationId);
  } else {
    repository.completeAccountOperation(operation.operationId);
  }
} else {
  if (operation.kind === "delete") repository.completeAccountOperation(operation.operationId);
  else repository.compensateAccountOperation(operation.operationId);
}
```

For delete markers, `targetDigest` is `ABSENT_PROVIDER_DIGEST` and `appliedRevision` stores the account `runtimeRevision` observed before config removal. `finalizeDeleteOperation()` deletes only when that runtime revision still matches, then removes the marker in the same SQLite transaction. A token refresh may change credential `revision` without superseding deletion; any re-login/account replacement changes `runtimeRevision` and therefore wins.

Use `RECOVERY_DRAIN_RETRY_MS = 5_000`. `mode: "cli"` processes create/update markers only and leaves delete markers untouched. `mode: "server"` calls `canDeleteAccount(providerId)` before every delete-marker finalization and orphan deletion. After marker recovery, use `ORPHAN_ACCOUNT_GRACE_MS = 30 * 60_000`: inspect raw provider record keys under the same config lock, skip every account with a pending operation, and delete only an unreferenced account whose `updatedAt` is older than the grace and whose predicate is true. A false predicate keeps the row and contributes `now + RECOVERY_DRAIN_RETRY_MS` to `nextRunAt`. This closes a crash window around manual file deletion without racing an active login, a provider re-add, or an in-flight server request; plugin removal does not trigger it because the provider entry remains in config. Return the minimum future marker-TTL, orphan-grace, or drain-retry deadline as `nextRunAt`.

`deleteOAuthAccount()` stages the revision-conditional delete marker and removes the raw provider entry under `AtomicConfigFile.transaction()`, but returns the marker identity without finalizing it. Task 11's server integration supplies snapshot verification under the same file lock and finalizes only after the retired snapshot drains; recovery is the crash fallback.

Call recovery at the beginning of every CLI plugin/provider mutation and during async server startup in Task 11.

- [ ] **Step 7: Implement generic capability resolution**

`provider login [capability] [--provider <id>]` accepts:

- canonical `@scope/package#capability`;
- an unambiguous short capability ID;
- interactive selection when no argument is supplied;
- an explicit ambiguity error listing canonical references in non-interactive mode.
- `--provider <id>` to infer the canonical capability from the structured config entry and preload its account for re-login; if the entry is absent, report cleanup-pending. If a capability argument is also present it must resolve to the same reference.

Without `--provider`, the command always uses create semantics. If the returned fingerprint already belongs to an account, print the canonical re-login command and leave config/vault unchanged. Always persist canonical `plugin` and `capability`; never persist the short alias.

Export the command action for direct unit tests, but do not change `packages/cli/src/main.ts` or the live `provider-commands.ts` dispatch in this task. Task 11 wires the generic action atomically with the new config parser and runtime materializer.

- [ ] **Step 8: Run login and recovery tests**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins/provider-id.test.ts packages/core/_test/plugins/account-login.test.ts packages/cli/_test/provider-plugin-login.test.ts
```

Expected: PASS for create, explicit re-login, duplicate protection, discovery failure, compensation, crash recovery, drain gating, and capability ambiguity.

- [ ] **Step 9: Commit the login transaction**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git add packages/core/src/plugins packages/core/_test/plugins packages/cli
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git commit -m "feat(oauth): transact plugin account login" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 9: Migrate GitHub Copilot into a Built-In Plugin Package

**Files:**
- Create: `packages/plugins/github-copilot/package.json`
- Create: `packages/plugins/github-copilot/rslib.config.ts`
- Create: `packages/plugins/github-copilot/tsconfig.json`
- Copy and modify: `packages/oauth/src/github-copilot/schema.ts` -> `packages/plugins/github-copilot/src/schema.ts`
- Create: `packages/plugins/github-copilot/src/github-api.ts`
- Create: `packages/plugins/github-copilot/src/runtime.ts`
- Create: `packages/plugins/github-copilot/src/index.ts`
- Copy and modify: `packages/oauth/_test/github-copilot.test.ts` -> `packages/plugins/github-copilot/_test/github-copilot.test.ts`
- Create: `packages/plugins/github-copilot/_test/runtime.test.ts`
- Modify: `tsconfig.json`
- Modify: `bun.lock`

**Interfaces:**
- Produces: default v1 descriptor, `createGitHubCopilotPlugin(copy)`, and version export.
- Registers: OAuth capability ID `default`.
- Account options: GitHub.com or Enterprise URL; no plugin-level options.
- Credential: GitHub token, Copilot token, expiry, base URL, and optional enterprise URL.
- Catalog metadata: canonical SDK `ProtocolId`.

This task copies behavior into the new package. Do not delete or rewrite the legacy `packages/oauth` source/tests yet: the live CLI/server still compile against them until Task 11, and Task 13 removes the package after cutover.

- [ ] **Step 1: Copy behavior tests and rewrite them against the adapter**

Preserve the current HTTP fixtures and assert:

- ConfigSpec has `deploymentType` select and conditional `enterpriseURL` text field;
- invalid Enterprise domain fails before fetch;
- device presentation uses `verification_uri_complete`;
- `authorization_pending`, `slow_down`, denial, timeout, and abort semantics remain;
- login returns fingerprint `"12345"`, suggested key `"copilot-12345"`, and label `"octocat"` without writing DB/config;
- discovery refreshes the Copilot token and filters hidden/non-chat models;
- catalog policy is TTL with exactly 6 hours;
- catalog metadata protocols are `"openai-compatible"`, `"anthropic"`, and `"openai-response"`;
- dynamic credential wrapper uses a refreshed token without rebuilding runtime;
- raw resolver returns transport only when protocol matches the model metadata.

- [ ] **Step 2: Run migrated tests to verify they fail**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/plugins/github-copilot/_test
```

Expected: FAIL because the package and adapter do not exist.

- [ ] **Step 3: Add the public package manifest**

Use package name `@aio-proxy/plugin-github-copilot`, public `dist` exports, Rslib build, and dependencies:

```json
{
  "@aio-proxy/plugin-sdk": "workspace:*",
  "@ai-sdk/anthropic": "catalog:",
  "@ai-sdk/openai": "catalog:",
  "@ai-sdk/openai-compatible": "catalog:"
}
```

Do not depend on core, server, CLI, types, the private i18n package, or the `zod` package. Import `zod`, `ConfigSpec`, and the remaining contract types from `@aio-proxy/plugin-sdk`.

- [ ] **Step 4: Implement account options and login**

Define:

```ts
const accountOptions = {
  schema: zod
    .object({
      deploymentType: zod.enum(["github.com", "enterprise"]).default("github.com"),
      enterpriseURL: zod.string().optional(),
    })
    .superRefine(validateEnterpriseURL)
    .transform(normalizeEnterpriseURL),
  form: [
    {
      type: "select",
      key: "deploymentType",
      label: copy.deploymentTypeLabel,
      options: [
        { value: "github.com", label: copy.githubDotComLabel },
        { value: "enterprise", label: copy.enterpriseLabel },
      ],
    },
    {
      type: "text",
      key: "enterpriseURL",
      label: copy.enterpriseURLLabel,
      placeholder: copy.enterpriseURLPlaceholder,
      when: { key: "deploymentType", equals: "enterprise" },
    },
  ],
} as const satisfies ConfigSpec<GitHubAccountOptions>;
```

The login result is data only:

```ts
return {
  fingerprint: user.id,
  suggestedKey: `copilot-${user.id}`,
  ...(user.login === undefined ? {} : { label: user.login }),
  credentials: {
    githubToken,
    copilotToken: copilot.access,
    expiresAt: copilot.expires,
    baseURL,
    ...(enterpriseURL === undefined ? {} : { enterpriseURL }),
  },
  expiresAt: copilot.expires,
};
```

- [ ] **Step 5: Implement discovery, ProviderV4, and raw transport**

Use `COPILOT_CATALOG_TTL_MS = 6 * 60 * 60_000`. Use the credential port to refresh an expired Copilot token; the exchange callback must pass the host-provided abort signal to every refresh fetch. Return a complete catalog with non-language arrays empty:

```ts
return {
  language: models.map((model) => ({
    id: model.id,
    ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
    metadata: { protocol: model.protocol },
  })),
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
};
```

Create three official AI SDK providers with placeholder credentials and a custom fetch wrapper that rereads/refreshed credentials per request. Return a composite ProviderV4 whose required methods delegate to those providers and whose `languageModel(modelId)` selects the provider from catalog metadata.

The optional raw resolver rewrites the incoming request origin to the current credential `baseURL`, preserves path/query/body/signal, injects Copilot headers, and returns `undefined` unless `input.protocol` equals that model's catalog protocol.

- [ ] **Step 6: Provide English default copy and an injectable localized factory**

The package default export must be:

```ts
export default createGitHubCopilotPlugin(englishCopy);
```

Export `createGitHubCopilotPlugin(copy)` so the embedded host can supply `packages/i18n` strings without making this public package depend on private i18n. Read the package version from `../package.json` at build time; do not hardcode a source constant that Changesets can desynchronize:

```ts
import packageJson from "../package.json" with { type: "json" };

export const GITHUB_COPILOT_PLUGIN_VERSION = packageJson.version;
```

- [ ] **Step 7: Run package tests and boundary checks**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun install
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/plugin-github-copilot build
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/plugins/github-copilot/_test
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk rg -n '@aio-proxy/(core|server|cli|types|i18n)' packages/plugins/github-copilot/src
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk rg -n 'from .zod.|"zod"[[:space:]]*:' packages/plugins/github-copilot
```

Expected: build/tests PASS and both boundary searches print no matches.

- [ ] **Step 8: Commit the Copilot plugin**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git add tsconfig.json bun.lock packages/plugins/github-copilot
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git commit -m "feat(plugin-github-copilot): migrate oauth adapter" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 10: Migrate OpenAI ChatGPT into a Built-In Plugin Package

**Files:**
- Create: `packages/plugins/openai-chatgpt/package.json`
- Create: `packages/plugins/openai-chatgpt/rslib.config.ts`
- Create: `packages/plugins/openai-chatgpt/tsconfig.json`
- Copy: `packages/oauth/src/openai-chatgpt/jwt.ts` -> `packages/plugins/openai-chatgpt/src/jwt.ts`
- Copy: `packages/oauth/src/openai-chatgpt/pkce.ts` -> `packages/plugins/openai-chatgpt/src/pkce.ts`
- Copy and modify: `packages/oauth/src/openai-chatgpt/schema.ts` -> `packages/plugins/openai-chatgpt/src/schema.ts`
- Copy and modify: `packages/oauth/src/openai-chatgpt/oauth-flow.ts` -> `packages/plugins/openai-chatgpt/src/oauth-flow.ts`
- Create: `packages/plugins/openai-chatgpt/src/runtime.ts`
- Create: `packages/plugins/openai-chatgpt/src/index.ts`
- Copy and modify: `packages/oauth/_test/openai-chatgpt.test.ts` -> `packages/plugins/openai-chatgpt/_test/crypto.test.ts`
- Copy and modify: `packages/oauth/_test/openai-chatgpt-oauth-flow.test.ts` -> `packages/plugins/openai-chatgpt/_test/oauth-flow.test.ts`
- Copy and modify: `packages/oauth/_test/openai-chatgpt-provider.test.ts` -> `packages/plugins/openai-chatgpt/_test/adapter.test.ts`
- Create: `packages/plugins/openai-chatgpt/_test/runtime.test.ts`
- Modify: `tsconfig.json`
- Modify: `bun.lock`

**Interfaces:**
- Produces: default v1 descriptor, `createOpenAIChatGPTPlugin(copy)`, and version export.
- Registers: OAuth capability ID `default`.
- Uses: fixed host loopback `http://localhost:1455/auth/callback` with manual callback URL enabled.
- Credential: access token, rotating refresh token, expiry, and ChatGPT account ID.
- Catalog: static language model list.

As in Task 9, copy the implementation and fixtures. Keep every legacy `packages/oauth` file intact through Task 12 so intermediate commits continue to build and test; Task 13 performs the single package deletion.

- [ ] **Step 1: Copy and rewrite existing tests against the adapter**

Assert:

- account ConfigSpec validates `{}` and has no fields;
- PKCE/state behavior is unchanged;
- login calls `context.authorization.loopback()` with hostname `localhost`, port `1455`, path `/auth/callback`, and `allowManualCallbackUrl: true`;
- the authorization URL contains the actual redirect URI returned by the host;
- login returns account ID as fingerprint and `chatgpt-${accountId}` as suggested key;
- authorization code exchange posts the selected redirect URI;
- refresh retains the previous refresh token when upstream omits a new one and stores a new one when supplied;
- static catalog contains the four current models;
- concurrent expired requests reach `CredentialPort.refresh`, not a plugin-local CAS;
- dynamic fetch injects access/account headers and rewrites Responses/Completions paths to the Codex endpoint.

- [ ] **Step 2: Run migrated tests to verify they fail**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/plugins/openai-chatgpt/_test
```

Expected: FAIL because the package and adapter do not exist.

- [ ] **Step 3: Add the public package manifest**

Use package name `@aio-proxy/plugin-openai-chatgpt` and dependencies:

```json
{
  "@aio-proxy/plugin-sdk": "workspace:*",
  "@ai-sdk/openai": "catalog:",
  "es-toolkit": "catalog:",
  "jose": "catalog:"
}
```

Do not depend on the `zod` package; copy/migrate every schema import to `zod` from `@aio-proxy/plugin-sdk`. Do not move the old loopback server; Task 6 replaced it with host-owned authorization.

- [ ] **Step 4: Implement login and static catalog**

Generate PKCE and state inside the plugin, then:

```ts
const { code, redirectUri } = await context.authorization.loopback({
  state,
  redirect: {
    hostname: "localhost",
    port: 1455,
    path: "/auth/callback",
  },
  authorizationUrl: ({ redirectUri }) =>
    buildAuthorizationUrl({ challenge: pkce.challenge, redirectUri, state }),
  allowManualCallbackUrl: true,
});
const token = await exchangeCodeForTokens(code, pkce.verifier, {
  redirectUri,
  signal: context.signal,
});
return {
  fingerprint: token.accountId,
  suggestedKey: `chatgpt-${token.accountId}`,
  label: token.accountId,
  credentials: token,
  expiresAt: token.expiresAt,
};
```

Return the fixed model list in `catalog.discover()` with every non-language modality set to `[]`.

- [ ] **Step 5: Implement dynamic credential refresh and ProviderV4**

The fetch wrapper:

```ts
async function currentCredential(port: CredentialPort<ChatGPTCredential>) {
  const current = await port.read();
  if (current.value.expiresAt > Date.now() && current.value.accessToken.length > 0) {
    return current.value;
  }
  return (
    await port.refresh(current.revision, async ({ value }, signal) => ({
      value: await refreshAccessToken(value.refreshToken, { signal }),
    }))
  ).snapshot.value;
}
```

Remove caller authorization, inject `Bearer <accessToken>`, `ChatGPT-Account-Id`, `Originator`, `User-Agent`, and a fresh session ID. Delegate all required ProviderV4 methods to `createOpenAI()` and return no raw resolver in v1.

- [ ] **Step 6: Export English default copy and localized factory**

Use the same pattern as Copilot:

```ts
export default createOpenAIChatGPTPlugin(englishCopy);
```

The public package remains independent of private i18n. Read `../package.json` at build time and export the synchronized version:

```ts
import packageJson from "../package.json" with { type: "json" };

export const OPENAI_CHATGPT_PLUGIN_VERSION = packageJson.version;
```

- [ ] **Step 7: Run package tests and boundary checks**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun install
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/plugin-openai-chatgpt build
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/plugins/openai-chatgpt/_test
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk rg -n '@aio-proxy/(core|server|cli|types|i18n)' packages/plugins/openai-chatgpt/src
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk rg -n 'from .zod.|"zod"[[:space:]]*:' packages/plugins/openai-chatgpt
```

Expected: build/tests PASS and both boundary searches print no matches.

- [ ] **Step 8: Commit the ChatGPT plugin**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git add tsconfig.json bun.lock packages/plugins/openai-chatgpt
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git commit -m "feat(plugin-openai-chatgpt): migrate oauth adapter" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 11: Build and Atomically Swap the Plugin Runtime Snapshot

**Files:**
- Modify: `packages/types/src/provider.ts`
- Modify: `packages/types/src/config.ts`
- Modify: `packages/types/rslib.config.ts`
- Modify: `packages/types/_test/schemas.test.ts`
- Modify: `packages/types/_test/config.test.ts`
- Modify: `packages/types/_test/example-config.test.ts`
- Modify: `packages/core/src/plugins/builtins.ts`
- Create: `packages/core/src/provider/provider-v4.ts`
- Create: `packages/core/_test/plugins/builtins.test.ts`
- Create: `packages/core/_test/provider/provider-v4.test.ts`
- Create: `packages/server/src/plugin-runtime.ts`
- Create: `packages/server/src/catalog-scheduler.ts`
- Delete: `packages/server/src/oauth-runtime.ts`
- Delete: `packages/server/src/oauth-chatgpt-runtime.ts`
- Delete: `packages/server/src/oauth-alias.ts`
- Create: `packages/server/_test/plugin-runtime.test.ts`
- Create: `packages/server/_test/plugin-snapshot.test.ts`
- Create: `packages/server/_test/catalog-scheduler.test.ts`
- Modify: `packages/core/package.json`
- Modify: `packages/core/tsconfig.json`
- Modify: `bun.lock`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/plugins/diagnostic.ts`
- Modify: `packages/core/src/router.ts`
- Modify: `packages/server/package.json`
- Modify: `packages/server/src/runtime.ts`
- Modify: `packages/server/src/provider-runtime.ts`
- Modify: `packages/server/src/config-store.ts`
- Modify: `packages/server/src/server-state.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/routes/pipeline.ts`
- Modify: `packages/server/src/dashboard-routes/config.ts`
- Modify: `packages/server/_test/anthropic-messages.test.ts`
- Modify: `packages/server/_test/cross-protocol-routing.test.ts`
- Modify: `packages/server/_test/config-store.test.ts`
- Modify: `packages/server/_test/dashboard-events.test.ts`
- Modify: `packages/server/_test/dashboard-provider-options-schema.test.ts`
- Modify: `packages/server/_test/dashboard-providers-mutation.test.ts`
- Modify: `packages/server/_test/dashboard-request-logs.test.ts`
- Modify: `packages/server/_test/dashboard-static.test.ts`
- Modify: `packages/server/_test/gemini-generate-content.test.ts`
- Modify: `packages/server/_test/gemini-missing-provider.test.ts`
- Modify: `packages/server/_test/models-dev-catalog.test.ts`
- Modify: `packages/server/_test/openai-completions.test.ts`
- Modify: `packages/server/_test/openai-responses-missing-provider.test.ts`
- Modify: `packages/server/_test/openai-responses.test.ts`
- Modify: `packages/server/_test/pipeline-helpers.ts`
- Modify: `packages/server/_test/pipeline.test.ts`
- Modify: `packages/server/_test/provider-runtime-capabilities.test.ts`
- Modify: `packages/server/_test/server-reload.test.ts`
- Modify: `packages/server/_test/server.test.ts`
- Modify: `packages/server/_test/usage-dashboard.test.ts`
- Delete: `packages/server/_test/oauth-provider-runtime.test.ts`
- Delete: `packages/server/_test/oauth-chatgpt-runtime.test.ts`
- Delete: `packages/server/_test/oauth-alias.test.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/provider-commands.ts`
- Modify: `packages/cli/_test/provider-commands.test.ts`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`

**Interfaces:**
- Produces: final structured `OAuthProviderSchema`, `ConfigAuthoringSchema`, and operational `ConfigSchema` output with `plugins`, valid `providers`, and `invalidProviders`.
- Produces: `createEmbeddedBuiltIns()`, `validateProviderV4()`, `createProviderV4Invoke()`, `materializePluginProvider()`, and host-owned `CatalogScheduler`.
- Changes: `createServer()` and `createServerState()` become async because plugin import/setup/runtime creation are async.
- Produces: one immutable snapshot containing config, plugin registry/state, provider state, runtime capabilities, probes, summaries, and Router.
- Preserves: a synchronous `currentProviderSnapshot()` for read-only inspection, and adds reference-counted `acquireProviderSnapshot()` for request dispatch and safe retirement.

- [ ] **Step 1: Write failing structured-config cutover tests**

Add exact Types coverage:

```ts
test("degrades invalid and legacy provider entries independently", () => {
  const config = ConfigSchema.parse({
    plugins: [],
    providers: {
      valid: {
        kind: "api",
        protocol: "openai-compatible",
        baseURL: "https://api.example.test/v1",
      },
      legacy: { kind: "oauth", vendor: "github-copilot" },
      broken: {
        kind: "oauth",
        plugin: "@example/oauth",
        capability: "",
      },
    },
  });

  expect(config.providers.map((provider) => provider.id)).toEqual(["valid"]);
  expect(config.invalidProviders).toEqual([
    {
      id: "legacy",
      kind: ProviderKind.OAuth,
      code: "LEGACY_OAUTH_CONFIG_UNSUPPORTED",
      issuePaths: [["vendor"]],
    },
    {
      id: "broken",
      kind: ProviderKind.OAuth,
      code: "PROVIDER_CONFIG_INVALID",
      issuePaths: [["capability"]],
    },
  ]);
});

test("keeps authoring schema strict and documents the structured oauth shape", () => {
  expect(
    ConfigAuthoringSchema.safeParse({
      providers: { legacy: { kind: "oauth", vendor: "github-copilot" } },
    }).success,
  ).toBe(false);
  expect(
    ConfigAuthoringSchema.safeParse({
      providers: {
        copilot: {
          kind: "oauth",
          plugin: "@aio-proxy/plugin-github-copilot",
          capability: "default",
        },
      },
    }).success,
  ).toBe(true);
});
```

Also prove invalid `server`, `plugins`, or a non-record `providers` value still rejects the whole config; valid providers retain descending weight with config-order ties; and no raw invalid provider value appears in `Config` output.

- [ ] **Step 2: Write failing embedded built-in and ProviderV4 tests**

Assert:

- both reserved identities use embedded descriptors even when a same-name cache exists;
- `plugin add` and loader identify them as built-in with package versions;
- built-in form/label/instructions copy comes from current `packages/i18n` locale;
- `validateProviderV4(createOpenAI({ apiKey: "test" }))` is true for the callable official provider object;
- ProviderV4 validation rejects wrong specification version, missing required methods, and non-function optional fields;
- the model transport calls `provider.languageModel(routedModelId)` and streams through the existing AI SDK bridge.

- [ ] **Step 3: Write failing snapshot/runtime tests**

Use injected fake built-ins plus isolated repository rows. Test:

- provider record key becomes runtime `id`;
- catalog language models become direct self-routes; configured rename/preserve aliases use shared `Router.modelRoutes()` semantics and retain catalog display metadata;
- invalid and legacy provider entries remain in summaries but never enter Router;
- missing plugin, missing capability, invalid account options, invalid credential, missing catalog, and runtime creation failure map to their stable diagnostics;
- a `createRuntime()` promise exceeding 5 seconds becomes `RUNTIME_CREATE_FAILED` and cannot delay other providers;
- malformed discovered or stored catalogs map to `CATALOG_UNAVAILABLE` without exposing plugin data;
- a bad plugin does not prevent an API or AI SDK provider from routing;
- ready API/AI SDK provider states omit `catalog`, while every ready OAuth provider state sets `fresh` or `stale`;
- setup runs for every candidate snapshot while descriptor import remains cached;
- `createRuntime` runs at most once per enabled account per successful snapshot;
- a diagnostic-only snapshot reuses the prior runtime identity and does not call `createRuntime` again;
- disabled OAuth providers validate enough stored state for diagnostics but do not call `createRuntime`, enter Router, or schedule catalog work;
- plugin/config/options/login/catalog changes rebuild affected runtime;
- credential revision refresh alone does not rebuild runtime;
- plugin removal drops its capability in the next snapshot and leaves account rows untouched;
- an in-flight request keeps the old runtime after swap;
- provider deletion removes it for new routing immediately but defers physical account deletion until old snapshot leases drain;
- server recovery refuses delete/orphan cleanup while any current or retired snapshot containing that Provider ID is not drained;
- overlapping slow/fast reloads commit in file-write order and never let the older candidate overwrite the newer snapshot;
- failed root config or Router construction keeps the prior snapshot;
- failed candidates do not replace scheduler jobs or start timers;
- pending/orphan recovery timers reschedule at the earliest deadline and stop on server close;
- failed plugin setup still permits a successful snapshot with that plugin failed.

After these fixtures cover the migrated behavior, delete `oauth-provider-runtime.test.ts`, `oauth-chatgpt-runtime.test.ts`, and `oauth-alias.test.ts`; do not keep duplicate tests tied to the obsolete server-private abstractions.

- [ ] **Step 4: Write failing raw dispatch and scheduler tests**

Test:

- all four internal `ProviderProtocol` values map exhaustively to SDK `ProtocolId`;
- same-protocol raw resolver wins;
- the host passes the selected catalog descriptor's validated `metadata` into the SDK RawResolver;
- resolver `undefined` falls back to ProviderV4;
- malformed resolver output or a non-`Response` transport result is a provider attempt failure and advances to the next candidate;
- cross-protocol never invokes raw;
- API, AI SDK, and plugin providers share weight/config-order fallback;
- plugin raw failure advances to the next candidate;
- stream preflight still prevents replay after first output;
- static catalog does not schedule after a stored first result;
- TTL catalog refresh success stores a new snapshot and rebuilds runtime;
- refresh failure with old catalog keeps ready/stale;
- refresh failure without catalog stays unavailable;
- catalog discovery/refresh receives an abort signal and times out after 30 seconds;
- catalog failure schedules one retry after 5 minutes and never forms an immediate rebuild loop;
- scheduler timers and in-flight jobs stop on server close;
- removing a plugin/account while discovery is in flight discards the late result and cannot resurrect its catalog/provider.

- [ ] **Step 5: Run the new config and runtime tests to verify they fail**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/types/_test/schemas.test.ts packages/types/_test/config.test.ts packages/core/_test/plugins/builtins.test.ts packages/core/_test/provider/provider-v4.test.ts packages/server/_test/plugin-runtime.test.ts packages/server/_test/plugin-snapshot.test.ts packages/server/_test/catalog-scheduler.test.ts
```

Expected: FAIL because per-provider degradation, the embedded host, ProviderV4 bridge, and plugin snapshot path do not exist.

- [ ] **Step 6: Activate structured OAuth while degrading invalid entries**

In `provider.ts`, replace the legacy `OAuthProviderSchema` definition with the staged schema:

```ts
export const OAuthProviderSchema = OAuthPluginProviderSchema;
export type OAuthProviderInput = z.input<typeof OAuthProviderSchema>;
export type OAuthProvider = z.output<typeof OAuthProviderSchema>;
```

Keep `OAuthVendor` exported only until Task 13 so the not-yet-deleted legacy source files still compile; it must no longer participate in `ProviderSchema` or config output.

In `config.ts`, separate strict authoring from tolerant operational parsing:

```ts
const ProviderInputValueSchema = z
  .discriminatedUnion("kind", [
    ApiProviderSchema.omit({ id: true }),
    OAuthProviderSchema.omit({ id: true }),
    AiSdkProviderSchema.omit({ id: true }),
  ])
  .superRefine(validateAliasTargets);

export const ConfigAuthoringSchema = z.object({
  server: ServerConfigSchema.prefault({}),
  plugins: PluginsInputSchema,
  providers: z.record(z.string().min(1), ProviderInputValueSchema),
});

const ConfigEnvelopeSchema = z.object({
  server: ServerConfigSchema.prefault({}),
  plugins: PluginsInputSchema,
  providers: z.record(z.string().min(1), z.unknown()),
});

export const ConfigSchema = ConfigEnvelopeSchema.transform((input) => {
  const providers: Provider[] = [];
  const invalidProviders: InvalidProviderConfig[] = [];
  for (const [id, raw] of Object.entries(input.providers)) {
    if (isLegacyOAuthEntry(raw)) {
      invalidProviders.push({
        id,
        kind: ProviderKind.OAuth,
        code: "LEGACY_OAUTH_CONFIG_UNSUPPORTED",
        issuePaths: [["vendor"]],
      });
      continue;
    }
    const result = ProviderInputValueSchema.safeParse(raw);
    if (!result.success) {
      const kind = inferProviderKind(raw);
      invalidProviders.push({
        id,
        ...(kind === undefined ? {} : { kind }),
        code: "PROVIDER_CONFIG_INVALID",
        issuePaths: result.error.issues.map(safeIssuePath),
      });
      continue;
    }
    providers.push(ProviderSchema.parse({ ...result.data, id }));
  }
  providers.sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0));
  return { server: input.server, plugins: input.plugins, providers, invalidProviders };
});

export type ConfigInput = z.input<typeof ConfigAuthoringSchema>;
```

`isLegacyOAuthEntry()` returns true for a record with `kind === "oauth"` and an own `vendor` key. `inferProviderKind()` returns only an exact `ProviderKind` value. `safeIssuePath()` keeps only string/number path segments and never includes the rejected value or Zod input. Generate `config.schema.json` from `ConfigAuthoringSchema`, not operational `ConfigSchema`.

Build the server `DiagnosticFactory` from `packages/i18n` and pass it to loader, credential, catalog, and runtime construction. Map each `InvalidProviderConfig` to an i18n-backed safe `Diagnostic` during snapshot construction. `LEGACY_OAUTH_CONFIG_UNSUPPORTED` tells the user to remove the row through the existing Dashboard delete action or config file and then run a new login; do not invent a nonexistent CLI delete command. `PROVIDER_CONFIG_INVALID` must not echo the invalid value.

- [ ] **Step 7: Bind embedded built-ins with localized copy**

`createEmbeddedBuiltIns()` returns definitions:

```ts
export function createEmbeddedBuiltIns(): readonly BuiltInPluginDefinition[] {
  return [
    {
      packageName: "@aio-proxy/plugin-github-copilot",
      version: GITHUB_COPILOT_PLUGIN_VERSION,
      descriptor: createGitHubCopilotPlugin({
        adapterLabel: m["oauth.github-copilot.login_label"](),
        deploymentTypeLabel: m["oauth.github-copilot.deployment_type.message"](),
        githubDotComLabel: m["oauth.github-copilot.deployment_type.options.github.label"](),
        enterpriseLabel: m["oauth.github-copilot.deployment_type.options.github-enterprise.label"](),
        enterpriseURLLabel: m["oauth.github-copilot.enterprise_url.message"](),
        enterpriseURLPlaceholder: m["oauth.github-copilot.enterprise_url.placeholder"](),
        deviceInstructions: m["oauth.github-copilot.device_instructions"](),
      }),
    },
    {
      packageName: "@aio-proxy/plugin-openai-chatgpt",
      version: OPENAI_CHATGPT_PLUGIN_VERSION,
      descriptor: createOpenAIChatGPTPlugin({
        adapterLabel: m["oauth.openai-chatgpt.login_label"](),
      }),
    },
  ];
}
```

Add the two built-in workspace packages, plugin SDK, and i18n to core dependencies/references. The cached-package branch must never run for these names.

- [ ] **Step 8: Validate and bridge ProviderV4 into model invocation**

Create `packages/core/src/provider/provider-v4.ts` with runtime validation colocated with the bridge:

```ts
const required = ["languageModel", "imageModel", "embeddingModel"] as const;
const optional = ["speechModel", "transcriptionModel", "rerankingModel", "files", "skills"] as const;

export function validateProviderV4(value: unknown): value is ProviderV4 {
  const valueType = typeof value;
  if (
    (valueType !== "object" && valueType !== "function") ||
    value === null ||
    Reflect.get(value, "specificationVersion") !== "v4"
  ) {
    return false;
  }
  return (
    required.every((name) => typeof Reflect.get(value, name) === "function") &&
    optional.every((name) => {
      const method = Reflect.get(value, name);
      return method === undefined || typeof method === "function";
    })
  );
}

export function createProviderV4Invoke(providerId: string, provider: ProviderV4): AiSdkProviderInstance["invoke"] {
  return (request) =>
    new ReadableStream({
      async start(controller) {
        try {
          const result = streamAiSdkText({
            model: provider.languageModel(request.modelId),
            messages: request.messages,
            ...(request.settings === undefined ? {} : { settings: request.settings }),
            ...(request.tools === undefined ? {} : { tools: request.tools }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          });
          for await (const part of result.fullStream) {
            if (part.type === "error") throw part.error;
            controller.enqueue(part);
          }
          controller.close();
        } catch (error) {
          controller.error(new AiSdkProviderError(providerId, error));
        }
      },
    });
}
```

The Core function returns its own `AiSdkProviderInstance["invoke"]` seam and never imports a server type. Server wraps it as `{ model: { invoke: createProviderV4Invoke(providerId, provider) } }`. Do not enumerate `files()` or `skills()`.

- [ ] **Step 9: Replace fixed raw transport with a resolver capability**

Define in `server/src/runtime.ts`:

```ts
export type RuntimeRawCapability = {
  readonly resolve: (input: {
    readonly protocol: ProviderProtocol;
    readonly modelId: string;
  }) => { readonly invoke: (request: Request) => Promise<Response> } | undefined;
};

export type RuntimeProviderInstance = {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly enabled: boolean;
  readonly models?: readonly ModelId[];
  readonly alias?: Readonly<Record<string, AliasConfig>>;
  readonly modelMetadata?: Readonly<Record<ModelId, RuntimeModelMetadata>>;
  readonly plugin?: string;
  readonly capability?: string;
  readonly hasApiKey?: boolean;
  readonly raw?: RuntimeRawCapability;
  readonly model?: ModelTransport;
};
```

Wrap API providers with a resolver closure that returns transport only for their configured protocol, set safe `hasApiKey`, and do not copy the key onto the generic runtime instance. The plugin wrapper must accept only `undefined` or an object with callable `invoke`; throw a typed, redacted `PluginRawResolverError` for any other return, and require the awaited invocation result to be a Web `Response`. Both failures flow through the shared candidate loop. Map plugin raw input with an exhaustive record:

```ts
const pluginProtocol = {
  [ProviderProtocol.OpenAICompatible]: "openai-compatible",
  [ProviderProtocol.OpenAIResponse]: "openai-response",
  [ProviderProtocol.Anthropic]: "anthropic",
  [ProviderProtocol.Gemini]: "gemini",
} as const satisfies Record<ProviderProtocol, ProtocolId>;
```

The plugin-facing wrapper closes over the validated language catalog and preserves the SDK input exactly:

```ts
const rawResolver = result.raw;
const raw: RuntimeRawCapability | undefined =
  rawResolver === undefined
    ? undefined
    : {
        resolve({ protocol, modelId }) {
          const descriptor = languageCatalogById.get(modelId);
          return rawResolver({
            protocol: pluginProtocol[protocol],
            modelId,
            ...(descriptor?.metadata === undefined ? {} : { metadata: descriptor.metadata }),
          });
        },
      };
```

In `pipeline.ts`, resolve raw once per candidate:

```ts
const raw = provider.raw?.resolve({ protocol: adapter.protocol, modelId: candidate.modelId });
if (raw !== undefined) {
  const upstream = await adapter.rawRequest(rawRequest, request, candidate.modelId, context);
  const response = await raw.invoke(upstream);
  if (hasNext && shouldFallbackStatus(response.status)) {
    session.attempt(failedAttempt(provider, candidate.modelId, response.status, startedAt, adapter.protocol));
    lastFailure = response;
    try {
      await response.body?.cancel();
    } catch {}
    continue;
  }
  if (response.status < 200 || response.status >= 400) {
    session.finish(finalFailure(provider, candidate.modelId, response.status, startedAt, adapter.protocol));
    return response;
  }
  const captured = source.usageCapture.passthrough({
    response,
    protocol: adapter.protocol,
    providerId: provider.id,
    modelId: candidate.modelId,
  });
  session.finishFrom(
    attemptBase(provider, candidate.modelId, startedAt, adapter.protocol),
    terminalCompletion(captured.completion, rawRequest.signal),
  );
  return captured.value;
}
```

Add an optional `protocol` parameter to `attemptBase()`, `failedAttempt()`, and `finalFailure()` and use it only for raw attempts. Model-path attempts do not invent an outbound protocol. Remove all route/vendor branching.

- [ ] **Step 10: Materialize plugin accounts**

For every structured OAuth provider, resolve and validate steps 1–6 for safe diagnostics. Only when `enabled` is true continue with steps 7–10 and add routing/scheduler capabilities:

1. resolve adapter from the committed registry;
2. read account by Provider ID and verify plugin/capability match;
3. reject public `options` containing secret form keys;
4. merge stored account secrets and validate account options through `parsePluginSchema()`;
5. validate stored credential through `parsePluginSchema()` and the adapter schema;
6. load persisted account diagnostics and catalog, then calculate ready/stale/unavailable;
7. create one stable credential port;
8. call `createRuntime()` once;
9. validate ProviderV4 and optional raw resolver;
10. derive `models`, metadata, routing aliases, and runtime capabilities.

Race `createRuntime()` against `PLUGIN_RUNTIME_TIMEOUT_MS = 5_000`. It has no abort signal because the SDK contract requires it to be local-only; attach rejection handling to a late promise and discard its result after timeout.

Populate the current text-routing `models` and `modelMetadata` only from `catalog.language`. Persist and return the other five modalities to the adapter runtime context, but do not expose them through v1 text protocol routing or `/v1/models`.

Define `RuntimeIdentityKey` as a branded `sha256:<hex>` string produced from stable recursively key-sorted JSON. Its input fields are package name + resolved version, capability, Provider ID, plugin-options digest, account-options digest, account `runtimeRevision`, catalog content digest, and catalog `refreshedAt`. When it matches the previous snapshot, reuse its ProviderV4/raw runtime object and stable credential port. Exclude credential `revision`, diagnostics, and enabled/weight/name/alias from the key. A diagnostic-only rebuild therefore updates immutable state without recreating runtime; re-login, options, plugin version, or any successful catalog refresh does recreate it. Never place raw plugin/account secret values in the key input; hash the already validated merged options separately and retain only their digest.

Create new credential ports with `onDiagnosticChanged: () => queueSnapshotRebuild("credential-diagnostic")`. Coalesce repeated requests onto the same serialized reload chain. Reused runtime identities must reuse the same port, so a token revision update remains visible without runtime reconstruction.

Persist diagnostics by `{ providerId, code }`, not one last-write-wins row. A `CREDENTIAL_REFRESH_FAILED` takes precedence, makes the provider unavailable, and excludes it from new Router candidates with a re-login suggestion. `CATALOG_UNAVAILABLE` remains ready/stale when a last-known-good catalog exists and unavailable otherwise. Re-login clears the credential diagnostic and independently clears/upserts the catalog diagnostic as part of its account transaction.

Add unavailable summaries for every `config.invalidProviders` row before materializing valid providers. A missing/failed plugin or bad OAuth account changes only that provider's state; API and AI SDK providers still materialize into the same candidate snapshot.

`Router.directModelIds()` must use `provider.models` whenever that property exists, including plugin OAuth runtime providers; config-only OAuth entries still have no `models`.

Generalize Core's router constraint away from the config union:

```ts
export type RoutableProvider = {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly enabled: boolean;
  readonly models?: readonly ModelId[];
  readonly alias?: Readonly<Record<string, AliasConfig>>;
};

export class Router<TProvider extends RoutableProvider = ProviderInstance> { /* existing logic */ }
export function modelRoutes(provider: RoutableProvider): ModelRoute[] { /* existing logic */ }
```

`directModelIds()` starts from `"models" in provider ? provider.models ?? [] : []` and applies the existing alias/preserve algebra. It must not special-case `ProviderKind.OAuth`.

Delete `server/src/oauth-runtime.ts`, `oauth-chatgpt-runtime.ts`, and `oauth-alias.ts` in this same vertical cutover. No compiled server source may still access `provider.vendor` after `OAuthProviderSchema` changes shape.

- [ ] **Step 11: Make startup/reload asynchronous and expose generic login atomically**

Change:

```ts
export async function createServerState(options: ServerStateOptions): Promise<ServerState>
export async function createServer(options: CreateServerOptions): Promise<AppType>
```

Update the default app with top-level await. Change every server test listed in this task to `await createServer(...)` or `await createServerState(...)`; do not leave a synchronous compatibility wrapper.

Replace the live vendor command at the same cutover:

```ts
provider
  .command("login [capability]")
  .description(m.cli_provider_login_description())
  .option("--provider <id>")
  .action(providerLogin);
```

`packages/cli/src/provider-commands.ts` must delegate to `plugin-commands/provider-login.ts` and stop importing vendor providers. Add localized copy for `ProviderAccountAlreadyExistsError`, `AccountCleanupPendingError`, target/capability mismatch, and fingerprint mismatch. Update `packages/cli/_test/provider-commands.test.ts` to assert optional capability selection, canonical `plugin#capability` persistence, explicit `--provider` re-login, capability/target mismatch rejection, duplicate-account guidance, cleanup-pending behavior, and fingerprint mismatch rollback.

Before initial snapshot, call pending-operation recovery with `{ mode: "server", canDeleteAccount: () => true }` because no process-local snapshot exists yet. After startup, the snapshot manager implements `canDeleteAccount(providerId)` as false while the current snapshot or any undrained retired snapshot contains that provider. Schedule one server-owned recovery timer for the returned `nextRunAt`; each run passes that predicate, calls recovery again, and reschedules, while `close()` clears it. For every reload:

```ts
const candidate = await buildSnapshot(candidateConfig, dependencies);
snapshot = candidate;
```

Do not mutate the live registry, runtime list, Router, summaries, or state before candidate completion. A plugin failure is data inside `candidate`; root parse and Router errors reject the candidate.

Add a reference-counted snapshot lease:

```ts
export type ProviderSnapshotLease = {
  readonly snapshot: ProviderRouteSnapshot;
  readonly release: () => void;
};

export type RetiredProviderSnapshot = {
  readonly providerIds: ReadonlySet<string>;
  readonly whenDrained: Promise<void>;
};

export type ProviderRouteSource = {
  readonly acquireProviderSnapshot: () => ProviderSnapshotLease;
  readonly currentProviderSnapshot: () => ProviderRouteSnapshot;
  // existing recorder and usage ports
};
```

The pipeline acquires exactly once before model resolution. Immediate error/JSON paths release in `finally`; raw/model streaming paths attach the one-shot release to the existing completion/cancel promise. Async dashboard probes and model-list assembly also acquire/release around their work. Swapping retires the old snapshot, prevents new acquisitions, and resolves its `whenDrained` promise when the reference count reaches zero.

Replace `server/src/config-store.ts`'s private promise-only writer with `AtomicConfigFile.replace()`. Pass a `verify(candidate)` callback that builds and swaps from that exact in-memory candidate; a rejected reload restores the prior bytes while the same cross-process lock is still owned.

Serialize every explicit, watcher-triggered, catalog-triggered, and diagnostic-triggered rebuild through one promise chain in `server-state.ts`, and read watcher input only inside its queued operation. Diagnostic/catalog-only jobs use the latest committed `snapshot.config` when their turn begins. A rejected operation must not poison the chain. This prevents a slower older async plugin snapshot from swapping after a newer config; the config-store verify path uses the candidate passed under lock, while watcher paths parse the latest on-disk bytes when their turn begins.

- [ ] **Step 12: Add host-owned catalog scheduling**

Candidate snapshots contain immutable catalog job descriptors but start no timers. After `snapshot = candidate`, call one server-owned `scheduler.replaceJobs(candidate.catalogJobs)`; it aborts/removes obsolete jobs and schedules the new set. A failed candidate leaves current jobs untouched. Each job has a scheduler generation token; after discovery and before any repository write, discard the result unless the same `{ providerId, generation }` is still active. Use `CATALOG_RETRY_MS = 5 * 60_000`. For `static`, schedule only when no catalog exists. For `ttl`, calculate due time from `refreshedAt + ttlMs`; missing/stale jobs run immediately unless a stored `CATALOG_UNAVAILABLE.occurredAt + CATALOG_RETRY_MS` is later. Wrap each `discover()` call in a 30-second host deadline, pass its abort signal through `AccountContext.signal`, and discard late results.

On success, validate the returned catalog before persistence:

```ts
const catalog = validateModelCatalog(discovered);
repository.writeCatalog(providerId, catalog, Date.now());
repository.clearDiagnostic(providerId, "CATALOG_UNAVAILABLE");
await rebuildSnapshot("catalog");
```

On failure, preserve existing catalog and write `CATALOG_UNAVAILABLE`; rebuild so ready/stale or unavailable state becomes visible. `close()` clears timers and aborts scheduler-owned signals.

- [ ] **Step 13: Cascade OAuth account data after provider config deletion**

Use `deleteOAuthAccount()` for Dashboard deletion and the same removal detector for manual config-watcher edits. Under `AtomicConfigFile.transaction()`, detect whether an account row exists, stage a runtime-revision-conditional delete marker, remove the raw provider entry, and let the config-store `verify(candidate)` build/swap the new snapshot. Because `AtomicConfigFile.verify` intentionally returns `void`, the server wrapper captures the returned `RetiredProviderSnapshot` in a local variable inside `verify`. After the transaction succeeds it registers a terminally handled drain callback; do not await stream drain while holding the file lock.

The callback invokes `finalizeDeleteIfStillAbsent(operationId)`, which re-enters a no-rewrite `AtomicConfigFile.transaction()`, rereads the raw provider entry, and only then calls `repository.finalizeDeleteOperation()`. If the entry has been re-added, complete/cancel the old marker without deleting the account. Periodic recovery uses the same locked helper after `canDeleteAccount()` returns true.

The marker's revision CAS performs the physical cascade of account options secrets, credential, catalog, refresh lease, and diagnostics. New requests stop seeing the provider immediately, while an existing stream can finish with its old credential port. If the process crashes after config removal, startup recovery finalizes it; if the provider/account was recreated at a newer revision, recovery returns `superseded` and preserves it. The snapshot manager's `canDeleteAccount()` also gates the periodic recovery path, so it cannot race the direct drain callback. The route must recognize invalid/legacy provider summaries as deletable even though they are absent from `config.providers`. API and AI SDK deletion skips marker creation because no account row exists.

- [ ] **Step 14: Run config, runtime, routing, reload, CLI, and scheduler tests**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun install
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run i18n:compile
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/types/_test
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins packages/core/_test/provider/provider-v4.test.ts
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/server/_test
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/cli/_test/provider-plugin-login.test.ts packages/cli/_test/provider-commands.test.ts
```

Expected: PASS; plugin failures are isolated and routing behavior remains model-first/capability-based.

- [ ] **Step 15: Commit the immutable runtime snapshot**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git add bun.lock packages/types packages/core packages/server packages/cli packages/i18n
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git commit -m "feat(server): materialize oauth plugin snapshots" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 12: Expose Read-Only Plugin and Provider Diagnostics

**Files:**
- Modify: `packages/types/src/dashboard.ts`
- Modify: `packages/server/src/dashboard-routes/config.ts`
- Modify: `packages/server/src/server-state.ts`
- Create: `packages/dashboard/src/modules/providers/services/plugins-service.ts`
- Create: `packages/dashboard/src/modules/providers/components/plugins-table.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-state-cell.tsx`
- Create: `packages/dashboard/src/modules/providers/components/plugins-table.test.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-state-cell.test.tsx`
- Modify: `packages/dashboard/src/modules/providers/hooks/use-providers-table.ts`
- Modify: `packages/dashboard/src/modules/providers/templates/providers-page.tsx`
- Modify: `packages/dashboard/src/modules/providers/services/providers-service.ts`
- Modify: `packages/cli/src/provider-commands.ts`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`

**Interfaces:**
- Produces: `GET /dashboard/api/plugins` and extended provider summaries.
- Dashboard displays only safe diagnostic fields and suggested CLI commands.
- CLI provider list prints ready/stale/unavailable without exposing secrets.

- [ ] **Step 1: Write failing dashboard schema and server route tests**

Add schema fixtures:

```ts
const failedPlugin = {
  packageName: "@example/broken",
  builtIn: false,
  version: "1.2.3",
  state: {
    status: "failed",
    diagnostic: {
      code: "PLUGIN_LOAD_FAILED",
      summary: "Plugin setup failed.",
      retryable: true,
      occurredAt: "2026-07-14T00:00:00.000Z",
      suggestedCommand: "aio-proxy plugin config @example/broken",
    },
  },
};
```

Assert provider summaries can include:

```ts
{
  state: { status: "ready", catalog: "stale" },
  plugin: "@aio-proxy/plugin-github-copilot",
  capability: "default",
  accountLabel: "octocat",
  expiresAt: 1_900_000_000_000,
  catalogLastSuccessAt: "2026-07-14T00:00:00.000Z"
}
```

Server route tests must serialize neither stored credential/secret JSON nor original error stacks.

- [ ] **Step 2: Write failing dashboard component tests**

Test that:

- built-in and third-party plugin rows show ready/failed;
- provider rows show ready, stale, and unavailable;
- diagnostic summary and suggested command render;
- credential failures render `aio-proxy provider login --provider <id>` rather than an ambiguous capability-only re-login;
- account label/expiry and capability reference render;
- no install, configuration form, secret field, or OAuth login button exists.
- OAuth/invalid rows expose delete and diagnostics only; existing API/AI SDK edit controls remain unchanged.

- [ ] **Step 3: Run dashboard tests to verify they fail**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/types/_test/schemas.test.ts packages/server/_test/dashboard-static.test.ts
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/dashboard test:unit
```

Expected: FAIL because plugin/state response types and UI do not exist.

- [ ] **Step 4: Extend shared dashboard types**

Add:

```ts
export const DashboardPluginSummarySchema = z.object({
  packageName: z.string().min(1),
  builtIn: z.boolean(),
  version: z.string().optional(),
  state: PluginStateSchema,
});

export const DashboardPluginsResponseSchema = z.object({
  plugins: z.array(DashboardPluginSummarySchema),
});
```

Extend `DashboardProviderSummarySchema` with:

```ts
state: ProviderStateSchema,
plugin: z.string().optional(),
capability: z.string().optional(),
accountLabel: z.string().optional(),
expiresAt: z.number().int().optional(),
catalogLastSuccessAt: z.string().datetime().optional(),
```

Allow dashboard-only `kind: "invalid"` for provider entries whose original kind cannot be safely inferred. Routed provider and request log types remain unchanged.

- [ ] **Step 5: Add the typed route and services**

`GET /plugins` returns `state.pluginSummaries()`. `plugins-service.ts` must use the typed Hono client and TanStack Query:

```ts
export const pluginsQueryOptions = () =>
  queryOptions({
    queryKey: ["plugins"],
    queryFn: async () => {
      const response = await dashboardClient.dashboard.api.plugins.$get();
      return response.json();
    },
  });
```

No component calls `fetch` directly.

- [ ] **Step 6: Build the read-only UI**

`PluginsTable` is one React component in its file, uses TanStack Table plus shadcn Table, and has package, source, version, state, and diagnostic columns. `ProviderStateCell` renders the small state union and safe diagnostic details.

`ProvidersPage` queries plugins and providers, renders `PluginsTable` above the existing provider table, adds capability/account/catalog columns, and retains the existing delete action. Hide the existing edit action for `oauth` and `invalid` rows; API and AI SDK editing remains unchanged. It does not render plugin install/config/login controls.

All copy and ARIA text must use new i18n messages.

- [ ] **Step 7: Update CLI provider list**

Print `state.status`, catalog freshness when present, plugin/capability, account label, and safe suggested command. For `CREDENTIAL_REFRESH_FAILED` the command is exactly `aio-proxy provider login --provider <provider-id>`. Keep probe output separate from availability state.

- [ ] **Step 8: Run server and dashboard tests**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run i18n:compile
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/types/_test packages/server/_test/dashboard-static.test.ts packages/server/_test/dashboard-providers-mutation.test.ts packages/cli/_test/provider-commands.test.ts
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/dashboard test:unit
```

Expected: PASS; rendered/API payloads contain no credentials or secrets.

- [ ] **Step 9: Commit read-only observability**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git add packages/types packages/server packages/dashboard packages/cli packages/i18n
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git commit -m "feat(dashboard): show oauth plugin diagnostics" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 13: Remove the Legacy OAuth Package and Vendor Switches

**Files:**
- Delete: `packages/oauth/`
- Create: `packages/core/src/db/migrations/0005_drop_legacy_auth.sql`
- Modify generated: `packages/core/src/db/migrations.manifest.ts`
- Modify: `packages/core/_test/plugins/repository.test.ts`
- Modify: `packages/types/src/provider.ts`
- Modify: `packages/cli/package.json`
- Modify: `packages/server/package.json`
- Modify: `packages/core/src/db/schema/index.ts`
- Delete: `packages/core/src/db/schema/auth.ts`
- Modify: `tsconfig.json`
- Modify: `bun.lock`

**Interfaces:**
- Removes: the remaining `OAuthVendor`, `BaseOAuthProvider`, `Auth`, old payload/CAS APIs, `onAuth(url)`, package manifests, and database schema export after Task 11 already removed server vendor switches.
- Preserves: behavior tests now owned by the two built-in packages, credential port, and shared plugin runtime tests.

- [ ] **Step 1: Add a failing legacy-symbol absence check**

Run this before deleting:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk rg -n 'OAuthVendor|BaseOAuthProvider|@aio-proxy/oauth|packages/oauth|createOAuthRuntimeProvider|openAIChatGPTOAuthProvider|githubCopilotOAuthProvider|Auth\.(get|set|cas|del)' packages package.json tsconfig.json
```

Expected: matches remain in old implementation and tests.

- [ ] **Step 2: Remove the exact old files, enum, schema export, and dependencies**

Delete every path listed above. Remove `@aio-proxy/oauth` from `packages/cli/package.json` and `packages/server/package.json`; remove the `packages/oauth` root TypeScript project reference; remove the transitional `OAuthVendor` enum from `packages/types/src/provider.ts`; remove the `auth` export from `packages/core/src/db/schema/index.ts`; and regenerate `bun.lock`. Keep migration `0000_auth.sql` immutable because migration history is append-only. Add `0005_drop_legacy_auth.sql` containing exactly `DROP TABLE IF EXISTS \`auth\`;`, regenerate the manifest, and assert both upgraded and fresh databases end without the legacy table.

- [ ] **Step 3: Verify migrated behavior ownership after source deletion**

The three server tests removed in Task 11 covered vendor-specific construction or alias helpers. Their user-visible behavior remains asserted in these exact replacement suites:

- `packages/plugins/github-copilot/_test/`;
- `packages/plugins/openai-chatgpt/_test/`;
- `packages/core/_test/plugins/`;
- `packages/server/_test/plugin-runtime.test.ts`;
- `packages/server/_test/plugin-snapshot.test.ts`;
- `packages/cli/_test/provider-plugin-login.test.ts`.

- [ ] **Step 4: Verify no legacy symbol or file remains**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk rg -n 'OAuthVendor|BaseOAuthProvider|@aio-proxy/oauth|packages/oauth|createOAuthRuntimeProvider|openAIChatGPTOAuthProvider|githubCopilotOAuthProvider|Auth\.(get|set|cas|del)' packages package.json tsconfig.json
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk rg --files packages/server/src packages/server/_test | PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk rg 'oauth-(runtime|chatgpt-runtime|alias|provider-runtime)'
```

Expected: both searches print no matches.

- [ ] **Step 5: Run focused migration tests**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun install
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run build:migrations
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/plugins/github-copilot/_test packages/plugins/openai-chatgpt/_test packages/core/_test/plugins packages/server/_test/plugin-runtime.test.ts packages/cli/_test/provider-plugin-login.test.ts
```

Expected: PASS with no legacy package resolution.

- [ ] **Step 6: Commit the clean break**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git add -A packages bun.lock tsconfig.json
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git commit -m "refactor(oauth): remove vendor-specific runtime" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 14: Verify Distribution and Publish the Breaking Feature

**Files:**
- Create: `.changeset/oauth-plugin-system.md`
- Verify: all package manifests, exports, generated i18n output, migrations manifest, config schema, and compiled binary.

No source modification is expected in this task. A verification failure means the responsible earlier task is incomplete; fix it in that task's declared files before continuing instead of adding an unspecified release-time patch.

**Interfaces:**
- Publishes: `@aio-proxy/plugin-sdk`, `@aio-proxy/plugin-github-copilot`, and `@aio-proxy/plugin-openai-chatgpt`.
- Ships: both built-ins embedded in the `aio-proxy` binary while retaining third-party dynamic package loading.

- [ ] **Step 1: Add the changeset**

Create:

```md
---
"@aio-proxy/cli": major
"@aio-proxy/plugin-sdk": major
"@aio-proxy/plugin-github-copilot": major
"@aio-proxy/plugin-openai-chatgpt": major
---

Replace vendor-specific OAuth support with a public OAuth plugin SDK, embedded GitHub Copilot and OpenAI ChatGPT plugins, host-owned authorization and vault persistence, and read-only plugin diagnostics.
```

The repository's Changesets fixed group synchronizes `aio-proxy` and all `@aio-proxy/*` versions. Use a major bump because the provider config and stored OAuth data are intentionally incompatible; the three new public packages therefore enter the fixed release at the same version.

- [ ] **Step 2: Run formatting and type/build checks**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run i18n:compile
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run build:migrations
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run check
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run build
```

Expected: every command exits 0.

- [ ] **Step 3: Run all unit and API end-to-end tests**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run test:unit
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run test:e2e:api
```

Expected: all tests PASS without real OAuth network access.

- [ ] **Step 4: Verify package boundaries and published manifests**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk rg -n '@aio-proxy/(core|server|cli)' packages/plugin-sdk/src packages/plugins
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk rg -n 'from .zod.|"zod"[[:space:]]*:' packages/plugins
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk rg -n '"private": true' packages/plugin-sdk/package.json packages/plugins/github-copilot/package.json packages/plugins/openai-chatgpt/package.json
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun --cwd=packages/plugin-sdk pm pack --dry-run
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun --cwd=packages/plugins/github-copilot pm pack --dry-run
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun --cwd=packages/plugins/openai-chatgpt pm pack --dry-run
```

Expected: boundary/direct-Zod/private searches print no matches; each dry-run includes `dist` and package metadata.

- [ ] **Step 5: Build and smoke-test one compiled binary**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/dashboard build
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/cli build:binary darwin-arm64
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk ./npm/cli-darwin-arm64/bin/aio-proxy plugin list
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk ./npm/cli-darwin-arm64/bin/aio-proxy plugin add @aio-proxy/plugin-github-copilot --yes
```

Expected: binary build succeeds, list shows both embedded built-ins, and built-in add prints `already built in` without network/cache writes.

- [ ] **Step 6: Run clean-break and secret scans**

Run:

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk rg -n 'OAuthVendor|BaseOAuthProvider|@aio-proxy/oauth|packages/oauth|vendor.*github-copilot|vendor.*openai-chatgpt' packages package.json tsconfig.json
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk rg -n 'accessToken|refreshToken|authorization_code|code_verifier' packages/dashboard packages/types/src/dashboard.ts
```

Expected: both searches print no matches.

- [ ] **Step 7: Commit release metadata**

```bash
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git add .changeset/oauth-plugin-system.md
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git commit -m "chore: document oauth plugin release" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Final Verification Checklist

- [ ] A third-party OAuth integration can be implemented and loaded using only `@aio-proxy/plugin-sdk`.
- [ ] Built-in and third-party descriptors pass through the same validation and staging registration code.
- [ ] Plugin and account forms use the same ConfigSpec renderer and keep secret fields out of config.
- [ ] Copilot uses device code; ChatGPT uses host loopback plus full callback URL fallback.
- [ ] New login never overwrites an existing fingerprint; `--provider <id>` is the only re-login path and retains the targeted account's options/secrets.
- [ ] Legacy OAuth entries are visible as unavailable and do not prevent other providers from serving.
- [ ] Credential refresh performs one upstream rotating-token exchange across two processes.
- [ ] Catalog stale/unavailable behavior and runtime rebuild triggers match the design.
- [ ] Pipeline owns every candidate attempt and contains no plugin/vendor switch.
- [ ] Dashboard is read-only and displays only safe diagnostics.
- [ ] Provider deletion cascades account data; plugin removal and prune preserve account/vault data according to policy.
- [ ] No legacy OAuth abstraction or package remains.
# Migration note

The project remained unreleased after this plan was executed. The final implementation therefore supersedes the staged `0004`/`0005` migration steps below with one Drizzle-generated baseline and committed metadata.
