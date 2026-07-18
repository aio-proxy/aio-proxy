# OAuth Plugin Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add host-neutral OAuth quota snapshots and account-level reset operations with strict result validation, snapshot isolation, per-Provider-ID reset serialization, and no impact on model routing health.

**Architecture:** The SDK adds an optional `OAuthAdapter.quota` capability beside `catalog`. Core validates registration shape and every returned snapshot. Server extracts the existing account preparation path into a shared internal module, then builds a dedicated quota control-plane service that holds a plugin snapshot lease for each operation, performs reset preflight and mutation under a keyed FIFO tail, logs redacted failures, and never modifies `RuntimeProviderInstance.raw/model` or provider diagnostics.

**Tech Stack:** Bun 1.3.14, TypeScript 6, Zod 4, Rslib, SQLite-backed `PluginRepository`, Bun test.

## Global Constraints

- Execute this plan after `2026-07-18-oauth-plugin-icon.md`; it consumes the logger-aware registry host introduced there.
- Dashboard, HTTP endpoints, API DTOs, CLI commands, and callback page changes are out of scope.
- `PLUGIN_API_VERSION` remains `1`; `OAuthAdapter.quota` is optional.
- Quota is an account-management control-plane capability and must not be added to `RuntimeProviderInstance.raw` or `.model`.
- Public time values are epoch-millisecond `number` values validated with `Number.isSafeInteger`; do not expose `Date`.
- `remainingRatio` is optional, finite, and in the closed interval `0..1`; do not clamp it.
- Snapshot item order is plugin-owned and preserved exactly.
- Quota item IDs and reset-credit IDs are nonblank and unique within their own arrays.
- Unknown fields, accessors, symbol keys, cycles, sparse arrays, and non-plain objects are rejected from quota results.
- Reset is account-level; neither the operation interface nor plugin method accepts a quota item ID or credit ID.
- Reset requires a fresh direct `quota.read()` inside the Provider ID lock and `resetCredits.availableCount > 0`.
- Missing/zero/unknown inventory rejects before mutation.
- Reset mutation is called once and is never automatically retried.
- Reset success returns `void`; no automatic post-reset read occurs.
- Same-Provider-ID resets serialize; different Provider IDs remain concurrent.
- Ordinary read single-flight is not implemented in v1. It remains a future MAY optimization and no TTL cache is introduced.
- Quota failures produce structured redacted logs but never write persistent provider routing diagnostics or change provider state.
- New and materially modified server tests are colocated under `packages/server/src`, including the plugin-runtime tests used by the account-refactor task.
- `packages/server/_test/setup.ts` remains the canonical Bun preload; it is the only intentional legacy `_test` path in this plan.
- Shell commands use `rtk`.
- Commits append `Co-authored-by: Codex <noreply@openai.com>`.

---

### Task 1: Add SDK Quota Types and Bind the Optional Capability at Registration

**Files:**
- Modify: `packages/plugin-sdk/src/oauth.ts`
- Modify: `packages/plugin-sdk/src/oauth.types.ts`
- Modify: `packages/core/src/plugins/registry.ts`
- Modify: `packages/core/src/plugins/registry.test.ts`

**Interfaces:**
- Produces: `OAuthQuotaItem`, `OAuthQuotaResetCredit`, `OAuthQuotaResetCredits`, `OAuthQuotaSnapshot`, and `OAuthQuotaCapability<AccountOptions, Credential>`.
- Changes: `OAuthAdapter<AccountOptions, Credential>` gains `readonly quota?: OAuthQuotaCapability<AccountOptions, Credential>`.
- Registry snapshot preserves method receivers by binding `quota.read` and optional `quota.reset` to the quota object.

- [ ] **Step 1: Write failing SDK type and registry contract tests**

Extend `packages/plugin-sdk/src/oauth.types.ts` with a concrete quota adapter:

```ts
const quotaAdapter: OAuthAdapter<MyOptions, MyCredential> = {
  id: "quota",
  label: "Quota",
  account: adapter.account,
  credentials: adapter.credentials,
  login: adapter.login,
  catalog: adapter.catalog,
  createRuntime: adapter.createRuntime,
  quota: {
    async read(context) {
      const credential = await context.credentials.read();
      return {
        items: [{ id: "primary", label: "Primary", remainingRatio: credential.value.accessToken.length / 100 }],
        resetCredits: { availableCount: 1, items: [{ id: "credit-1", expiresAt: 1_800_000_000_000 }] },
      };
    },
    async reset(context) {
      await context.credentials.read();
    },
  },
};

api.oauth.register(quotaAdapter);
```

Add an `@ts-expect-error` fixture proving `Date` is not accepted:

```ts
// @ts-expect-error quota timestamps are epoch milliseconds
const invalidResetAt: OAuthQuotaItem = { id: "primary", label: "Primary", resetsAt: new Date() };
void invalidResetAt;
```

Extend `packages/core/src/plugins/registry.test.ts` with:

- a class-backed quota object whose `read()` and `reset()` use a private field, proving receiver binding survives snapshot reconstruction;
- an old adapter without `quota`, proving it still registers;
- table cases for `quota: null`, `quota: []`, missing/non-function `read`, and non-function `reset`, each asserting the plugin state is `failed`, the diagnostic code is `PLUGIN_LOAD_FAILED`, and no staged capability commits.

- [ ] **Step 2: Verify RED**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-sdk test:types
rtk bun test packages/core/src/plugins/registry.test.ts
```

Expected: FAIL because the SDK types and registry quota handling do not exist.

- [ ] **Step 3: Add the exact public SDK contract**

Insert these declarations after `AccountContext` in `packages/plugin-sdk/src/oauth.ts`:

```ts
export type OAuthQuotaItem = {
  readonly id: string;
  readonly label: LocalizedText;
  readonly remainingRatio?: number;
  readonly resetsAt?: number;
};

export type OAuthQuotaResetCredit = {
  readonly id: string;
  readonly expiresAt?: number;
};

export type OAuthQuotaResetCredits = {
  readonly availableCount: number;
  readonly items?: readonly OAuthQuotaResetCredit[];
};

export type OAuthQuotaSnapshot = {
  readonly items: readonly OAuthQuotaItem[];
  readonly resetCredits?: OAuthQuotaResetCredits;
};

export type OAuthQuotaCapability<AccountOptions, Credential> = {
  readonly read: (context: AccountContext<Credential, AccountOptions>) => Promise<OAuthQuotaSnapshot>;
  readonly reset?: (context: AccountContext<Credential, AccountOptions>) => Promise<void>;
};
```

Add this optional field to `OAuthAdapter`:

```ts
readonly quota?: OAuthQuotaCapability<AccountOptions, Credential>;
```

- [ ] **Step 4: Validate registration shape and bind quota methods**

In `packages/core/src/plugins/registry.ts`, add a focused helper:

```ts
function validateQuota(value: unknown): NonNullable<OAuthAdapter["quota"]> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid OAuth adapter");
  const { read, reset } = value;
  if (typeof read !== "function" || (reset !== undefined && typeof reset !== "function")) {
    throw new Error("Invalid OAuth adapter");
  }
  return {
    read: read.bind(value) as NonNullable<OAuthAdapter["quota"]>["read"],
    ...(reset === undefined
      ? {}
      : { reset: reset.bind(value) as NonNullable<OAuthAdapter["quota"]>["reset"] }),
  };
}
```

Destructure `quota` from the raw adapter, call `validateQuota(quota)`, and include the validated capability only when defined. Any quota shape error must escape `register()`, causing the loader's existing staging catch to seal without commit and mark the plugin failed.

- [ ] **Step 5: Verify GREEN and backward compatibility**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-sdk test:types
rtk bun test packages/core/src/plugins/registry.test.ts
rtk bun run --filter @aio-proxy/core build
```

Expected: valid class receivers work, malformed quota shapes fail the entire plugin atomically, and adapters without quota remain ready.

- [ ] **Step 6: Commit the SDK and registration contract**

```bash
git add packages/plugin-sdk/src/oauth.ts packages/plugin-sdk/src/oauth.types.ts packages/core/src/plugins/registry.ts packages/core/src/plugins/registry.test.ts
git commit -m "feat(plugin-sdk): define oauth quota capability" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Validate Quota Snapshots into Plain, Ordered Host Data

**Files:**
- Create: `packages/core/src/plugins/quota.ts`
- Create: `packages/core/src/plugins/quota.test.ts`
- Modify: `packages/core/src/plugins/index.ts`

**Interfaces:**
- Produces: `OAuthQuotaValidationError` with `readonly path: readonly (string | number)[]` and `validateOAuthQuotaSnapshot(value): OAuthQuotaSnapshot`.
- Consumes: `LocalizedTextSchema` from `@aio-proxy/plugin-sdk`.
- Guarantees: exact known fields only, plain copied objects/arrays, preserved item order, and no raw invalid value attached to errors.

- [ ] **Step 1: Write the failing quota validation matrix**

Create `packages/core/src/plugins/quota.test.ts` with a valid fixture:

```ts
const validSnapshot = () => ({
  items: [
    { id: "five-hour", label: { default: "5 hour", "zh-Hans": "5 小时" }, remainingRatio: 0.25, resetsAt: 1_800_000_000_000 },
    { id: "weekly", label: "Weekly", remainingRatio: 1 },
  ],
  resetCredits: {
    availableCount: 2,
    items: [{ id: "credit-a", expiresAt: 1_900_000_000_000 }],
  },
});
```

The tests must assert:

- the valid result equals but is not referentially identical to the input or its nested objects;
- item order remains `five-hour`, then `weekly`;
- `remainingRatio` accepts `0`, `1`, and omission;
- `availableCount` may differ from `items.length`;
- duplicate/blank item IDs fail at `items[index].id`;
- duplicate/blank reset-credit IDs fail at `resetCredits.items[index].id`;
- `NaN`, infinities, `-0.01`, and `1.01` ratios fail;
- `Date`, unsafe integers, and fractional timestamps fail;
- negative, fractional, and unsafe `availableCount` values fail;
- invalid `LocalizedText` fails;
- unknown fields at snapshot, item, reset inventory, and credit levels fail;
- accessor properties, symbol keys, sparse arrays, custom prototypes, and cyclic structures fail;
- caught errors are `OAuthQuotaValidationError`, have a stable path, and have no `cause` or raw `value` property.

- [ ] **Step 2: Verify RED**

Run:

```bash
rtk bun test packages/core/src/plugins/quota.test.ts
```

Expected: FAIL because the validator and error class do not exist.

- [ ] **Step 3: Implement strict structural readers**

Create `packages/core/src/plugins/quota.ts`. Use these exact helper contracts:

```ts
import { type LocalizedText, LocalizedTextSchema, type OAuthQuotaSnapshot } from "@aio-proxy/plugin-sdk";

type Path = readonly (string | number)[];

export class OAuthQuotaValidationError extends Error {
  readonly path: Path;

  constructor(path: Path) {
    super("Plugin quota snapshot is invalid");
    this.name = "OAuthQuotaValidationError";
    this.path = path;
  }
}

function invalid(path: Path): never {
  throw new OAuthQuotaValidationError(path);
}
```

Implement this callback-shaped reader so active-cycle tracking cannot leak across sibling values:

```ts
function withPlainRecord<T>(
  value: unknown,
  path: Path,
  allowedKeys: ReadonlySet<string>,
  ancestors: Set<object>,
  validate: (record: Readonly<Record<string, unknown>>) => T,
): T;
```

`withPlainRecord()` must:

- requires prototype `Object.prototype` or `null`;
- rejects objects already present in the active `ancestors` set;
- rejects every symbol key;
- rejects every accessor descriptor;
- rejects every own string key not present in `allowedKeys`;
- add the object to `ancestors`, call `validate(record)`, and remove it in `finally`.

Implement the analogous array reader:

```ts
function withDenseArray<T>(
  value: unknown,
  path: Path,
  ancestors: Set<object>,
  validate: (items: readonly unknown[]) => T,
): T;
```

`withDenseArray()` must:

- requires `Array.isArray(value)` and prototype `Array.prototype`;
- rejects symbols, accessors, extra string properties, and missing numeric indices;
- validates own canonical array-index keys and proves their count is dense before any length-sized
  iteration or allocation, so a maximally large sparse array rejects promptly;
- rejects active cycles;
- pass values to `validate()` in index order and remove the array from `ancestors` in `finally`.

Use focused validators with these signatures:

```ts
function quotaId(value: unknown, path: Path): string;
function localizedText(value: unknown, path: Path): LocalizedText;
function optionalRatio(value: unknown, path: Path): number | undefined;
function optionalTimestamp(value: unknown, path: Path): number | undefined;
function resetCount(value: unknown, path: Path): number;
```

`quotaId` requires a string whose `.trim()` is nonempty and returns the original string. `optionalRatio` requires a finite number between `0` and `1`. `optionalTimestamp` requires `Number.isSafeInteger(value)`. `resetCount` requires a nonnegative safe integer. `localizedText` uses `LocalizedTextSchema.safeParse()` and returns its plain parsed copy.

- [ ] **Step 4: Assemble and export the validated copy**

Implement:

```ts
export function validateOAuthQuotaSnapshot(value: unknown): OAuthQuotaSnapshot;
```

The function must allow only `items` and optional `resetCredits` at the root; only `id`, `label`, optional `remainingRatio`, and optional `resetsAt` on an item; only `availableCount` and optional `items` on reset inventory; and only `id` and optional `expiresAt` on a credit. Track duplicate IDs with separate `Set<string>` instances. Construct new objects with conditional spreads and return a new ordered array; never sort or clamp.

Export the validator and error from `packages/core/src/plugins/index.ts`.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
rtk bun test packages/core/src/plugins/quota.test.ts
rtk bun run --filter @aio-proxy/core build
```

Expected: all validation tests pass, including path assertions and copy identity checks.

- [ ] **Step 6: Commit quota result validation**

```bash
git add packages/core/src/plugins/quota.ts packages/core/src/plugins/index.ts packages/core/src/plugins/quota.test.ts
git commit -m "feat(plugins): validate oauth quota snapshots" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Extract Reusable OAuth Account Preparation from Runtime Materialization

**Files:**
- Create: `packages/server/src/plugin-account.ts`
- Create: `packages/server/src/plugin-account.test.ts`
- Modify: `packages/server/src/plugin-runtime/materialize.ts`
- Modify: `packages/server/src/plugin-runtime/capabilities.test.ts`
- Modify: `packages/server/src/plugin-runtime/catalog.test.ts`
- Modify: `packages/server/src/plugin-runtime/diagnostics.test.ts`
- Modify: `packages/server/src/plugin-runtime/identity.test.ts`
- Modify: `packages/server/src/plugin-runtime/materialize.test.ts`
- Modify: `packages/server/src/plugin-runtime/test-support.ts`

**Interfaces:**
- Produces: `OAuthPluginAccountPreparationError`, runtime `PreparedOAuthPluginAccount`, control-plane `PreparedOAuthControlPlaneAccount`, and `prepareOAuthPluginAccount(options)` overloads.
- Runtime preparation exposes the stored `account` and `accountOptionsIdentity` needed for runtime identity, and its credential factory retains the legacy raw `pluginSecrets` input for dynamic refresh-error redaction.
- Control-plane preparation exposes only collected `secretValues`; it omits the stored account and identity and its credential factory captures only copied `pluginSecretValues` strings.
- Preserves: every existing `materializePluginProvider()` diagnostic, suggested login command, runtime identity input, credential callback, and plugin secret redaction behavior.

- [ ] **Step 1: Verify the colocated plugin-runtime tests before refactoring**

The six plugin-runtime test/support files listed above live beside their source and use local
`./index` or sibling-module imports. Run them once before refactoring:

```bash
rtk bun test --preload=packages/server/_test/setup.ts packages/server/src/plugin-runtime
```

Expected: PASS, establishing the colocated runtime baseline before the shared preparation change.

- [ ] **Step 2: Write failing shared preparation tests**

Create `packages/server/src/plugin-account.test.ts`. Reuse the SQLite repository and registry fixture pattern from `plugin-runtime/test-support.ts` and cover:

- successful options parsing merges public config and stored secret options;
- the returned credential port reads the stored parsed credential;
- account/plugin/capability mismatch maps to `CREDENTIALS_MISSING_OR_INVALID`;
- invalid account options map to `ACCOUNT_OPTIONS_INVALID` with login guidance;
- invalid credentials map to `CREDENTIALS_MISSING_OR_INVALID` with login guidance;
- `PluginSchemaContractError` maps to `PLUGIN_LOAD_FAILED` without login guidance;
- failed/missing plugin and missing capability preserve the existing diagnostic codes;
- account label and expiry are copied into `accountSummary`;
- runtime `onDiagnosticChanged` and raw `pluginSecrets` are forwarded to the created credential port;
- control-plane input accepts only `pluginSecretValues`, returns no stored account/identity, redacts those values, and does not retain a later mutation of the raw plugin-secret object used to collect them.

- [ ] **Step 3: Verify RED**

Run:

```bash
rtk bun test --preload=packages/server/_test/setup.ts packages/server/src/plugin-account.test.ts
```

Expected: FAIL because the shared preparation module does not exist.

- [ ] **Step 4: Implement the shared account preparation seam**

Create `packages/server/src/plugin-account.ts` with these public internal types:

```ts
import type { DiagnosticFactory, PluginLogSink, PluginRegistrySnapshot, PluginRepository, StoredAccount } from "@aio-proxy/core";
import type { CredentialPort, OAuthAdapter } from "@aio-proxy/plugin-sdk";
import type { DiagnosticCode, OAuthProvider } from "@aio-proxy/types";

export type OAuthAccountSummary = {
  readonly accountLabel?: string;
  readonly expiresAt?: number;
};

export class OAuthPluginAccountPreparationError extends Error {
  constructor(
    readonly code: DiagnosticCode,
    readonly accountSummary: OAuthAccountSummary,
    readonly suggestLogin: boolean,
  ) {
    super("OAuth plugin account is unavailable");
    this.name = "OAuthPluginAccountPreparationError";
  }
}

type PreparedOAuthAccountBase = {
  readonly adapter: OAuthAdapter;
  readonly accountOptions: unknown;
  readonly accountSummary: OAuthAccountSummary;
  readonly createCredentials: () => CredentialPort<unknown>;
};

export type PreparedOAuthPluginAccount = PreparedOAuthAccountBase & {
  readonly credentialMode: "runtime";
  readonly account: StoredAccount;
  readonly accountOptionsIdentity: { readonly public: unknown; readonly secret: unknown };
};

export type PreparedOAuthControlPlaneAccount = PreparedOAuthAccountBase & {
  readonly credentialMode: "control-plane";
  readonly secretValues: readonly string[];
};
```

Use a mode-discriminated input:

```ts
type PrepareOAuthPluginAccountBaseOptions = {
  readonly config: OAuthProvider;
  readonly plugins: PluginRegistrySnapshot;
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly onDiagnosticChanged: () => void;
};

export type PrepareOAuthPluginAccountOptions = PrepareOAuthPluginAccountBaseOptions &
  (
    | { readonly credentialMode?: "runtime"; readonly pluginSecrets?: unknown; readonly pluginSecretValues?: never }
    | {
        readonly credentialMode: "control-plane";
        readonly pluginSecrets?: never;
        readonly pluginSecretValues?: readonly string[];
      }
  );
```

Move the existing logic from `materializePluginProvider()` in this exact order:

1. loaded plugin existence/failed state;
2. adapter resolution;
3. stored account read and plugin/capability match;
4. account summary creation;
5. config-spec secret-key enforcement and merged account-options parse;
6. credential schema parse and `PluginSchemaContractError` mapping;
7. Normalize omitted mode to runtime. Build the runtime credential factory with raw `pluginSecrets`
   so later nested values remain dynamically redactable. For control-plane, copy the supplied
   `pluginSecretValues`, collect stored credential/account-secret strings before return, and create
   the credential factory through a separate helper whose options contain only those strings.
8. Return the stored account and account-options identity only for runtime; return collected
   `secretValues` only for control-plane.

Use `isPlainObject` from `es-toolkit/predicate` for public and stored secret option containers instead
of a handwritten generic record check. This keeps literal/null-prototype JSON option objects valid
while rejecting arrays and class instances.

Throw `OAuthPluginAccountPreparationError` only for the existing mapped failure cases. Preserve unexpected non-contract exceptions rather than silently changing their behavior.

- [ ] **Step 5: Rewire materialization without changing output**

At the top of `materializePluginProvider()`, call `prepareOAuthPluginAccount(options)` and catch only `OAuthPluginAccountPreparationError`:

```ts
let prepared: PreparedOAuthPluginAccount;
try {
  prepared = await prepareOAuthPluginAccount(options);
} catch (error) {
  if (!(error instanceof OAuthPluginAccountPreparationError)) throw error;
  return failure(
    options,
    error.code,
    false,
    error.suggestLogin ? providerLoginCommand(options.config.id) : undefined,
    error.accountSummary,
  );
}
```

Use:

```ts
const { adapter, account, accountOptions, accountSummary, createCredentials } = prepared;
const accountOptionsDigest = digest(prepared.accountOptionsIdentity);
```

Delete the duplicated adapter/account/options/credential preparation block from `materialize.ts`; keep diagnostics, catalog, identity, runtime creation, and routing behavior in place.

- [ ] **Step 6: Verify account and runtime regression GREEN**

Run:

```bash
rtk bun test --preload=packages/server/_test/setup.ts packages/server/src/plugin-account.test.ts packages/server/src/plugin-runtime
rtk bun run --filter @aio-proxy/server test:unit
```

Expected: all tests pass; `materialize.ts` falls below 240 lines; no runtime identity or diagnostic snapshot changes.

- [ ] **Step 7: Commit the shared account seam and test move**

```bash
git add packages/server/src/plugin-account.ts packages/server/src/plugin-account.test.ts packages/server/src/plugin-runtime
git commit -m "refactor(server): share oauth account preparation" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Implement Snapshot-Isolated Quota Reads with Stable Errors and Redacted Logs

**Files:**
- Create: `packages/server/src/plugin-quota/errors.ts`
- Create: `packages/server/src/plugin-quota/context.ts`
- Create: `packages/server/src/plugin-quota/read.ts`
- Create: `packages/server/src/plugin-quota/test-support.ts`
- Create: `packages/server/src/plugin-quota/read.test.ts`
- Modify: `packages/core/src/plugins/diagnostic.ts`
- Modify: `packages/core/src/plugins/index.ts`

**Interfaces:**
- Produces: `OAuthQuotaCapabilityUnavailableError`, `OAuthQuotaReadError`, `OAuthQuotaResetUnsupportedError`, `OAuthQuotaResetUnavailableError`, `OAuthQuotaResetError`, `OAuthQuotaServiceDependencies`, `withOAuthQuotaContext()`, `readValidatedQuota()`, and `OAuthQuotaReader`.
- `OAuthQuotaReader`: `readonly read: (providerId: string, signal: AbortSignal) => Promise<OAuthQuotaSnapshot>`.
- Logging: code `QUOTA_READ_FAILED`, events `plugin.quota.read.failed` and `plugin.quota.reset.preflight.failed`.

- [ ] **Step 1: Write failing read operation tests**

Create `packages/server/src/plugin-quota/read.test.ts` using `test-support.ts` fixtures. Cover:

- the service resolves the OAuth provider by Provider ID from the leased snapshot;
- plugin `read()` receives parsed account options, a working credential port, and the caller's exact signal;
- returned items preserve plugin order;
- malformed snapshots reject with `OAuthQuotaReadError` and one redacted `QUOTA_READ_FAILED` log;
- plugin network/auth failures reject with `OAuthQuotaReadError` and credential, account-secret, and plugin-secret strings are absent from serialized logs;
- missing provider, non-OAuth provider, failed/missing plugin, missing capability, missing/mismatched account, and absent quota capability reject with `OAuthQuotaCapabilityUnavailableError` without calling the plugin;
- the snapshot lease remains held until the plugin promise settles;
- swapping the manager while a read is pending does not switch the operation to the new adapter/config;
- read failure leaves the original `providerStates`, providers array, router, and repository diagnostics unchanged;
- two simultaneous reads for one Provider ID invoke the plugin twice, documenting that v1 intentionally has no single-flight cache.

- [ ] **Step 2: Verify RED**

Run:

```bash
rtk bun test --preload=packages/server/_test/setup.ts packages/server/src/plugin-quota/read.test.ts
```

Expected: FAIL because the quota service modules and log code do not exist.

- [ ] **Step 3: Define stable safe errors and expose redaction collection**

In `packages/server/src/plugin-quota/errors.ts`, define classes with fixed messages and no raw `cause`:

```ts
export class OAuthQuotaCapabilityUnavailableError extends Error {
  readonly code = "OAUTH_QUOTA_CAPABILITY_UNAVAILABLE";
  constructor() {
    super("OAuth quota capability is unavailable");
    this.name = "OAuthQuotaCapabilityUnavailableError";
  }
}

export class OAuthQuotaReadError extends Error {
  readonly code = "OAUTH_QUOTA_READ_FAILED";
  constructor() {
    super("OAuth quota read failed");
    this.name = "OAuthQuotaReadError";
  }
}

export class OAuthQuotaResetUnsupportedError extends Error {
  readonly code = "OAUTH_QUOTA_RESET_UNSUPPORTED";
  constructor() {
    super("OAuth quota reset is unsupported");
    this.name = "OAuthQuotaResetUnsupportedError";
  }
}

export class OAuthQuotaResetUnavailableError extends Error {
  readonly code = "OAUTH_QUOTA_RESET_UNAVAILABLE";
  constructor() {
    super("OAuth quota reset is unavailable");
    this.name = "OAuthQuotaResetUnavailableError";
  }
}

export class OAuthQuotaResetError extends Error {
  readonly code = "OAUTH_QUOTA_RESET_FAILED";
  constructor() {
    super("OAuth quota reset failed");
    this.name = "OAuthQuotaResetError";
  }
}
```

Extend `PluginLogCode` with `"QUOTA_READ_FAILED" | "QUOTA_RESET_FAILED"` and re-export `collectSecretStrings` from `packages/core/src/plugins/index.ts`.

- [ ] **Step 4: Implement leased context resolution**

Create `packages/server/src/plugin-quota/context.ts` with:

```ts
import type {
  DiagnosticFactory,
  PluginLogSink,
  PluginRepository,
} from "@aio-proxy/core";
import type { AccountContext, OAuthAdapter } from "@aio-proxy/plugin-sdk";
import { ProviderKind } from "@aio-proxy/types";
import type { ProviderSnapshotLease } from "../runtime";
import { prepareOAuthPluginAccount } from "../plugin-account";
import { OAuthQuotaCapabilityUnavailableError } from "./errors";

export type OAuthQuotaServiceDependencies = {
  readonly acquireSnapshot: () => ProviderSnapshotLease;
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly onDiagnosticChanged: () => void;
};

export type PreparedOAuthQuotaContext = {
  readonly adapter: OAuthAdapter & { readonly quota: NonNullable<OAuthAdapter["quota"]> };
  readonly accountContext: AccountContext<unknown, unknown>;
  readonly plugin: string;
  readonly capability: string;
  readonly providerId: string;
  readonly secretValues: Set<string>;
};
```

Implement:

```ts
export async function withOAuthQuotaContext<T>(
  dependencies: OAuthQuotaServiceDependencies,
  providerId: string,
  signal: AbortSignal,
  operation: (prepared: PreparedOAuthQuotaContext) => Promise<T>,
): Promise<T>;
```

The function must acquire a lease first and release it in `finally`. From `lease.snapshot.config`, find the exact Provider ID and require `ProviderKind.OAuth`. Read the current plugin secret, immediately reduce it with `collectSecretStrings()`, and call `prepareOAuthPluginAccount()` with `credentialMode: "control-plane"` plus `pluginSecretValues`; never pass the raw object into preparation or the credential port. Require `adapter.quota`, seed the quota `Set` from the control-plane preparation's stored credential/account/plugin `secretValues`, create one tracking credential port, and construct `AccountContext`. The tracking wrapper adds strings from parsed/transformed reads, exchange inputs/results, and refresh results to `secretValues`. `PreparedOAuthQuotaContext` must not directly or transitively retain the complete stored account or raw plugin secret. Map provider/capability/account preparation failures to a new `OAuthQuotaCapabilityUnavailableError`; do not call the plugin on those paths. Do not inspect `RuntimeProviderInstance.raw/model`.

The control-plane credential mode preserves read/lease/single-flight/exchange/schema/CAS/metadata/result semantics and credential-failure logging. It suppresses persistent `CREDENTIAL_REFRESH_FAILED` diagnostic write/clear and both diagnostic/credential callbacks, so quota refresh cannot rebuild routing state.

- [ ] **Step 5: Implement direct validated read and safe logging**

Create `packages/server/src/plugin-quota/read.ts` with:

```ts
import { redactPluginError, validateOAuthQuotaSnapshot } from "@aio-proxy/core";
import type { OAuthQuotaSnapshot } from "@aio-proxy/plugin-sdk";
import { OAuthQuotaReadError } from "./errors";
import {
  type OAuthQuotaServiceDependencies,
  type PreparedOAuthQuotaContext,
  withOAuthQuotaContext,
} from "./context";

export type OAuthQuotaReader = {
  readonly read: (providerId: string, signal: AbortSignal) => Promise<OAuthQuotaSnapshot>;
};
```

Export `readValidatedQuota(dependencies, prepared, event)` to call `prepared.adapter.quota.read(prepared.accountContext)`, validate the raw result, and return the copy. On failure, log:

```ts
dependencies.logger({
  event,
  code: "QUOTA_READ_FAILED",
  context: {
    plugin: prepared.plugin,
    capability: prepared.capability,
    providerId: prepared.providerId,
  },
  error: redactPluginError(error, { secretValues: [...prepared.secretValues] }),
});
throw new OAuthQuotaReadError();
```

The quota log sink is best-effort; a throwing sink must not replace the stable operation error.

Export `createOAuthQuotaReader(dependencies)` whose `read()` calls `withOAuthQuotaContext()` and `readValidatedQuota(..., "plugin.quota.read.failed")`. Do not retain a promise map or snapshot cache.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
rtk bun test --preload=packages/server/_test/setup.ts packages/server/src/plugin-quota/read.test.ts
rtk bun run --filter @aio-proxy/core build
```

Expected: all read, lease, reload-isolation, redaction, and routing-state tests pass.

- [ ] **Step 7: Commit quota reads**

```bash
git add packages/core/src/plugins packages/server/src/plugin-quota
git commit -m "feat(server): add isolated oauth quota reads" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 5: Add Per-Provider Reset Serialization and Expose the Complete Service on Server State

**Files:**
- Create: `packages/server/src/plugin-quota/reset.ts`
- Create: `packages/server/src/plugin-quota/reset.test.ts`
- Create: `packages/server/src/plugin-quota/index.ts`
- Create: `packages/server/src/server-state/oauth-quota.test.ts`
- Modify: `packages/server/src/server-state/types.ts`
- Modify: `packages/server/src/server-state/index.ts`
- Modify: `.changeset/oauth-plugin-system.md`

**Interfaces:**
- Produces: `OAuthQuotaOperations` with `read(providerId, signal)` and `reset(providerId, signal)`.
- Produces: `createOAuthQuotaOperations(dependencies): OAuthQuotaOperations`.
- Changes: `ServerState` gains `readonly oauthQuota: OAuthQuotaOperations`.
- Reset lock owns only a `Map<string, Promise<void>>` of settled-safe tails; it stores no quota snapshot.

- [ ] **Step 1: Write failing reset protocol tests**

Create `packages/server/src/plugin-quota/reset.test.ts`. Cover:

- missing `quota.reset` throws `OAuthQuotaResetUnsupportedError` and never calls `quota.read`;
- missing `resetCredits` or `availableCount: 0` throws `OAuthQuotaResetUnavailableError` and never mutates;
- preflight rejection or invalid preflight snapshot propagates `OAuthQuotaReadError` and never mutates;
- successful reset calls one direct read, then one mutation, and no post-reset read;
- mutation rejection logs once, throws `OAuthQuotaResetError`, and is not retried;
- two same-Provider-ID resets execute `read -> reset -> read -> reset`, never `read -> read -> reset -> reset`;
- a failed first reset does not poison the next queued reset;
- reset calls for two different Provider IDs enter preflight concurrently;
- a normal read already in progress does not satisfy reset preflight; reset performs its own `quota.read` inside the lock;
- a snapshot swap while reset is pending does not mix old preflight with a new adapter mutation;
- reset resolve remains successful; a later independent `oauthQuota.read()` failure is reported only by that read;
- provider routing state and persistent diagnostics remain unchanged for every reset failure.

Create `packages/server/src/server-state/oauth-quota.test.ts` proving `createServerState()` returns an `oauthQuota` service and that a pathless/non-OAuth configuration returns `OAuthQuotaCapabilityUnavailableError` without an endpoint or Dashboard dependency.

- [ ] **Step 2: Verify RED**

Run:

```bash
rtk bun test --preload=packages/server/_test/setup.ts packages/server/src/plugin-quota/reset.test.ts packages/server/src/server-state/oauth-quota.test.ts
```

Expected: FAIL because reset serialization, the composed service, and `ServerState.oauthQuota` do not exist.

- [ ] **Step 3: Implement a failure-safe keyed serial tail**

In `packages/server/src/plugin-quota/reset.ts`, implement this private helper:

```ts
function createKeyedSerialExecutor(): <T>(key: string, operation: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}
```

This ensures failure does not poison the queue, map entries disappear after settlement, and unrelated keys have unrelated tails.

- [ ] **Step 4: Implement reset preflight and single mutation**

Export `createOAuthQuotaResetter(dependencies)` with `reset(providerId, signal)`. Queue by Provider ID first; acquire the snapshot lease only when the queued operation starts. Inside one `withOAuthQuotaContext()` callback:

1. require `prepared.adapter.quota.reset` and throw `OAuthQuotaResetUnsupportedError` before any read;
2. call `readValidatedQuota(dependencies, prepared, "plugin.quota.reset.preflight.failed")` directly;
3. require `snapshot.resetCredits?.availableCount > 0`, otherwise throw `OAuthQuotaResetUnavailableError`;
4. call `signal.throwIfAborted()` before mutation;
5. call the bound reset function exactly once with the same `AccountContext`;
6. return `void` without reading again.

On mutation failure, log event `plugin.quota.reset.failed`, code `QUOTA_RESET_FAILED`, the same plugin/capability/provider context, and `redactPluginError()` with the same three secret sources used by reads. Throw a new `OAuthQuotaResetError` without `cause`.

- [ ] **Step 5: Compose operations and attach them to server state**

Create `packages/server/src/plugin-quota/index.ts`:

```ts
import type { OAuthQuotaSnapshot } from "@aio-proxy/plugin-sdk";
import type { OAuthQuotaServiceDependencies } from "./context";
import { createOAuthQuotaReader } from "./read";
import { createOAuthQuotaResetter } from "./reset";

export type OAuthQuotaOperations = {
  readonly read: (providerId: string, signal: AbortSignal) => Promise<OAuthQuotaSnapshot>;
  readonly reset: (providerId: string, signal: AbortSignal) => Promise<void>;
};

export function createOAuthQuotaOperations(
  dependencies: OAuthQuotaServiceDependencies,
): OAuthQuotaOperations {
  return {
    ...createOAuthQuotaReader(dependencies),
    ...createOAuthQuotaResetter(dependencies),
  };
}

export * from "./errors";
```

Add `readonly oauthQuota: OAuthQuotaOperations` to `ServerState`. In `createServerState()`, after `manager` is initialized, construct:

```ts
const oauthQuota = createOAuthQuotaOperations({
  acquireSnapshot: manager.acquire,
  repository,
  diagnostics,
  logger: pluginLogger,
  onDiagnosticChanged: queueRebuild,
});
```

Return `oauthQuota` on the state object. Do not register a Hono route, CLI command, Dashboard query, provider capability, or external DTO.

Append this sentence to `.changeset/oauth-plugin-system.md`:

```md
OAuth adapters can now expose validated quota snapshots and optional account-level reset operations through a snapshot-isolated host service.
```

- [ ] **Step 6: Verify reset and server-state GREEN**

Run:

```bash
rtk bun test --preload=packages/server/_test/setup.ts packages/server/src/plugin-quota packages/server/src/server-state/oauth-quota.test.ts
rtk bun run --filter @aio-proxy/server test:unit
```

Expected: same-ID reset ordering is deterministic, different IDs run concurrently, no reset retries or post-read occur, and the service is available only as an internal server-state seam.

- [ ] **Step 7: Run the full affected verification**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-sdk test
rtk bun test packages/core/src/plugins/registry.test.ts packages/core/src/plugins/quota.test.ts
rtk bun run --filter @aio-proxy/core build
rtk bun run --filter @aio-proxy/server test:unit
rtk bun run check
rtk bun run preflight
```

Expected: every command passes; no HTTP, CLI, Dashboard, callback, or `RuntimeProviderInstance` file changes are present; `.reference` remains untouched.

- [ ] **Step 8: Commit reset operations and server-state exposure**

```bash
git add packages/server/src/plugin-quota packages/server/src/server-state .changeset/oauth-plugin-system.md
git commit -m "feat(server): serialize oauth quota resets" -m "Co-authored-by: Codex <noreply@openai.com>"
```
