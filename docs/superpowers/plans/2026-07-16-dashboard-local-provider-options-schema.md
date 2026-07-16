# Dashboard Local Provider Options Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve AI SDK options JSON Schemas in the dashboard from `@aio-proxy/provider-schemas`, delete the server options-schema API, and stop constraining options when no catalog schema exists.

**Architecture:** Schema lookup becomes a synchronous local call in the dashboard (`providerOptionsSchema` only). Package install/status stay on the server. `JsonEditor` skips Monaco schema registration and worker validation when `schema` is undefined so non-catalog packages only need valid object JSON. Shipping the published schema table (~70KB uncompressed `schema-module.js`) in the dashboard bundle is an intentional trade for removing the schema HTTP round-trip.

**Tech Stack:** `@aio-proxy/provider-schemas@0.1.1`, React, TanStack Query, Monaco JSON language service, Hono dashboard routes, Bun / rstest.

## Global Constraints

- Pin `@aio-proxy/provider-schemas` to exact `0.1.1` in the dashboard (same as current server pin).
- Import only the main entry (`providerOptionsSchema` and types); never `@aio-proxy/provider-schemas/zod`. Prefer a single `providerOptionsSchema` call — do not also call `hasProviderOptionsSchema` for the same lookup.
- Do not reintroduce a server proxy for static provider option schemas.
- After removals, drop `@aio-proxy/provider-schemas` from `packages/server` if no import remains.
- Prefer `rtk bun run …` for test/check commands (matches other dashboard plans; avoids rstest sandbox `EPERM` on some hosts). Plain `bun run` is fine when `rtk` is unavailable.
- `bun install` may use the already-locked `0.1.1` from the local bun store; if registry metadata refresh hangs offline, rely on the existing lock entry.
- Do not commit or push unless the user explicitly asks.

## File map

| File | Responsibility |
| --- | --- |
| `packages/dashboard/src/components/json-editor/json-editor-state.ts` | Pure validation state helpers; immediate complete when no schema |
| `packages/dashboard/src/components/json-editor/json-editor.tsx` | Skip Monaco schema register/validate when `schema` is undefined |
| `packages/dashboard/src/modules/providers/services/resolve-provider-options-schema.ts` | Local catalog lookup wrapper |
| `packages/dashboard/src/modules/providers/hooks/use-provider-options-schema.ts` | State machine: local schema on commit; status/install only via API |
| `packages/dashboard/src/modules/providers/services/provider-options-schema-service.ts` | Keep status + install; delete options-schema query |
| `packages/dashboard/src/modules/providers/components/provider-options-editor.tsx` | Drop `loading_schema` UI; keep visible status_error messaging |
| `packages/i18n/messages/en.json` / `zh-Hans.json` | Retarget load-error copy to package-status failure |
| `packages/server/src/dashboard-routes/provider-package-metadata.ts` | Drop `schemaAvailable` and `providerPackageOptionsSchema` |
| `packages/server/src/dashboard-routes/config.ts` | Delete `/providers/options-schema` route |
| `packages/server/_test/dashboard-provider-options-schema.test.ts` | Update package-status; delete options-schema cases |
| `packages/dashboard/package.json` / `packages/server/package.json` / `bun.lock` | Move dependency to dashboard; remove from server if unused |

---

### Task 1: JsonEditor — no schema means no Monaco schema validation

**Files:**
- Modify: `packages/dashboard/src/components/json-editor/json-editor-state.ts`
- Modify: `packages/dashboard/src/components/json-editor/json-editor.tsx`
- Test: `packages/dashboard/src/components/json-editor/json-editor-state.test.ts`

**Interfaces:**
- Produces: `beginJsonValidation(state, draft, schema)` — when `schema === undefined`, returns `pending: false` and `markers: []` in one step (no worker round-trip required).

- [ ] **Step 1: Write the failing test**

Add to `json-editor-state.test.ts`:

```ts
test("undefined schema completes immediately with empty markers", () => {
  const initial = createJsonValidationState("{}", { required: ["apiKey"] });
  const next = beginJsonValidation(initial, '{"custom":true}', undefined);

  expect(next).toMatchObject({
    draft: '{"custom":true}',
    schema: undefined,
    pending: false,
    markers: [],
  });
  expect(next.generation).toBe(initial.generation + 1);
  // Omit `schema: undefined` — under exactOptionalPropertyTypes, `schema?: JsonSchema`
  // rejects an explicit undefined property (IDE/tsc); validity does not need it here.
  expect(
    mergeJsonValidation({
      syntaxValid: true,
      markers: next.markers,
      pending: next.pending,
    }).valid,
  ).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/json-editor/json-editor-state.test.ts`

Expected: FAIL because `beginJsonValidation` still sets `pending: true` for `undefined` schema.

- [ ] **Step 3: Implement state + editor behavior**

In `json-editor-state.ts`, change `beginJsonValidation` so an undefined schema finishes immediately:

```ts
export const beginJsonValidation = (
  state: JsonValidationState,
  draft: string,
  schema: JsonSchema | undefined,
): JsonValidationState =>
  schema === undefined
    ? {
        generation: state.generation + 1,
        draft,
        schema: undefined,
        pending: false,
        markers: [],
      }
    : {
        generation: state.generation + 1,
        draft,
        schema,
        pending: true,
        markers: [],
      };
```

In `json-editor.tsx`:

1. Keep the schema effect cleanup so switching schema → `undefined` unregisters the previous Monaco registration.
2. Gate the worker effect so it does not call `validateJsonModel` when `schema` is undefined:

```ts
useEffect(() => {
  if (
    schema === undefined ||
    !editor ||
    !monaco ||
    !validationState.pending ||
    validationState.draft !== draft ||
    validationState.schema !== schema
  ) {
    return;
  }
  // existing validateJsonModel path unchanged
}, [draft, editor, modelUri, monaco, schema, validationState]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/json-editor/json-editor-state.test.ts`

Expected: PASS.

---

### Task 2: Local schema resolver + dashboard dependency

**Files:**
- Create: `packages/dashboard/src/modules/providers/services/resolve-provider-options-schema.ts`
- Create: `packages/dashboard/src/modules/providers/services/resolve-provider-options-schema.test.ts`
- Modify: `packages/dashboard/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Produces:

```ts
export type LocalProviderOptionsSchema =
  | {
      readonly resolution: "ready";
      readonly schema: Readonly<Record<string, unknown>>;
      readonly warnings: readonly { readonly code: string; readonly path: string }[];
    }
  | {
      readonly resolution: "unavailable";
      readonly schema: undefined;
      readonly warnings: readonly [];
    };

export const resolveLocalProviderOptionsSchema = (packageName: string): LocalProviderOptionsSchema;
```

- [ ] **Step 1: Add dependency**

In `packages/dashboard/package.json` dependencies:

```json
"@aio-proxy/provider-schemas": "0.1.1"
```

Run: `rtk bun install --registry=https://registry.npmjs.org/`  
(Same version is already in `bun.lock` / store; prefer cache if the registry is slow.)

- [ ] **Step 2: Write failing tests**

```ts
import { describe, expect, test } from "@rstest/core";
import { resolveLocalProviderOptionsSchema } from "./resolve-provider-options-schema";

describe("resolveLocalProviderOptionsSchema", () => {
  test("returns ready schema for a catalog package", () => {
    const result = resolveLocalProviderOptionsSchema("@ai-sdk/openai-compatible");
    expect(result.resolution).toBe("ready");
    if (result.resolution !== "ready") throw new Error("expected ready");
    expect(result.schema).toMatchObject({ type: "object" });
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  test("returns unavailable for a non-catalog package", () => {
    const result = resolveLocalProviderOptionsSchema("@vendor/custom-provider");
    expect(result.resolution).toBe("unavailable");
    expect(result.schema).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/providers/services/resolve-provider-options-schema.test.ts`

Expected: FAIL (module missing).

- [ ] **Step 4: Implement resolver (single lookup)**

```ts
import { providerOptionsSchema } from "@aio-proxy/provider-schemas";

export type LocalProviderOptionsSchema =
  | {
      readonly resolution: "ready";
      readonly schema: Readonly<Record<string, unknown>>;
      readonly warnings: readonly { readonly code: string; readonly path: string }[];
    }
  | {
      readonly resolution: "unavailable";
      readonly schema: undefined;
      readonly warnings: readonly [];
    };

export const resolveLocalProviderOptionsSchema = (packageName: string): LocalProviderOptionsSchema => {
  const entry = providerOptionsSchema(packageName);
  // `entry.schema === null` is required for exactOptional / JsonSchema | null narrowing
  // even though catalog entries with a name always expose a non-null schema today.
  if (entry === undefined || entry.schema === null) {
    return { resolution: "unavailable", schema: undefined, warnings: [] };
  }
  return {
    resolution: "ready",
    schema: entry.schema,
    warnings: entry.warnings,
  };
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/providers/services/resolve-provider-options-schema.test.ts`

Expected: PASS.

---

### Task 3: Rewrite provider-options schema state machine for local resolution

**Files:**
- Modify: `packages/dashboard/src/modules/providers/hooks/use-provider-options-schema.ts`
- Modify: `packages/dashboard/src/modules/providers/services/provider-options-schema-service.ts`
- Modify: `packages/dashboard/src/modules/providers/components/provider-options-editor.test.ts`
- Modify: `packages/dashboard/src/modules/providers/components/provider-options-editor.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Run: `bun run --filter @aio-proxy/i18n build` after message edits (paraglide compile — there is no `i18n:compile` script)

**Interfaces:**
- Consumes: `resolveLocalProviderOptionsSchema(packageName)`
- Removes events: `schema_loaded`, `schema_missing`, `schema_failed`
- Removes phases: `loading_schema`, `schema_error`
- Removes `schemaResolution` value `"loading"` (keep `"unknown" | "ready" | "unavailable" | "error"` where `"error"` is only for status failures)
- `ProviderPackageStatus` no longer includes `schemaAvailable`
- On `package_committed`, apply local schema resolution immediately with `phase: "checking"`
- **`providerOptionsAreValid` core predicates stay unchanged** (ready↔ready+schema, unavailable↔unavailable, install_error may still pair with ready schema). Only delete branches that reference removed phases.

**status_error UX (required — do not silently block):**

- Keep `externalInvalid={… || schemaState.schemaResolution === "error"}` on `JsonEditor`.
- Keep a `FieldError` when `schemaState.phase === "status_error"` or `schemaResolution === "error"`.
- Retarget `dashboard.providers.form.options_schema_load_error` copy to package-status failure (schema HTTP load no longer exists), e.g.:
  - en: `The provider package could not be checked. Saving is blocked until this completes.`
  - zh-Hans: `无法检查提供商包。在完成检查前无法保存。`
- Keep `options_schema_loading` in messages — it is currently used by the `loading_schema` helper branch (`provider-options-editor.tsx`) and becomes unused only after this task removes that branch; leave it (biome has no unused-key lint).

- [ ] **Step 1: Rewrite / delete tests by name (do this before production edits)**

In `provider-options-editor.test.ts`, treat the file as a bulk rewrite of the async-schema model:

**Delete entirely (HTTP schema / obsolete events):**

- `fresh schema errors win over cached schema data` (`providerSchemaRefetchEvent`)
- `schema missing is an explicit fallback state`
- `transient schema errors do not enable schema-less fallback`
- Service assertion that `providerOptionsSchemaQueryOptions(…).queryKey` includes `"options-schema"`
- Imports: `providerOptionsSchemaQueryOptions`, `providerSchemaRefetchEvent`

**Rewrite (remove `schemaAvailable`, drop `schema_loaded` / `loading_schema` / `schema_error` / `schemaResolution: "loading"`):**

- `blocks pending schema workflow phases but allows warning and unavailable fallbacks` — remove `loading_schema` / `schema_error` expectations; keep unavailable / install blocking cases that still apply
- `keeps embedded schema resolution independent from a failed trusted install` — schema is already ready on commit; install failure must not clear it; no `schema_loaded` event
- `allows schema-less fallback after a failed install only once unavailability is explicit` — non-catalog commit → unavailable immediately; install failure keeps unavailable
- `schema availability is independent of package install state` — installed/missing must not change local schema resolution; terminal phase is `ready` or `schema_unavailable`, never `loading_schema`
- `async completions for an old package are ignored` — keep generation guards for **status**/install events only (delete schema_* event cases)
- `same-package completions from an older generation are ignored` — status/install only
- `package change clears schema before the next commit`
- All remaining fixtures that still pass `schemaAvailable` in `status` (every `status_loaded` / status refetch fixture in the file)

**Add (local commit resolution):**

```ts
const committed = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
  type: "package_committed",
  packageName: "@ai-sdk/openai-compatible",
});
expect(committed).toMatchObject({
  phase: "checking",
  schemaResolution: "ready",
  schemaPackage: "@ai-sdk/openai-compatible",
});
expect(committed.schema).toBeDefined();

const unknown = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
  type: "package_committed",
  packageName: "@vendor/custom-provider",
});
expect(unknown).toMatchObject({
  phase: "checking",
  schemaResolution: "unavailable",
  schema: undefined,
  schemaPackage: null,
});
```

**Keep with only fixture cleanup (`schemaAvailable` removed):**

- Install confirm / deferred / retry / generation-ignore tests that are status/install-only
- `blocks status failures including invalid package names` — still expect `providerOptionsAreValid(…)` false **and** editor error path remains for `status_error`

- [ ] **Step 2: Run tests to verify they fail**

Run: `rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/providers/components/provider-options-editor.test.ts`

Expected: FAIL against the old reducer / service.

- [ ] **Step 3: Implement reducer + hook + service + editor messaging**

`package_committed` handler sketch:

```ts
case "package_committed": {
  const local = resolveLocalProviderOptionsSchema(event.packageName);
  return {
    ...initialProviderOptionsSchemaState,
    phase: "checking",
    committedPackage: event.packageName,
    commitGeneration: state.commitGeneration + 1,
    allowAutomaticInstall: event.allowAutomaticInstall ?? true,
    schemaResolution: local.resolution,
    schemaPackage: local.resolution === "ready" ? event.packageName : null,
    schema: local.schema,
    warnings: local.warnings,
  };
}
```

`status_loaded` sketch (no `schemaAvailable`):

```ts
case "status_loaded": {
  if (event.status.state === "missing") {
    // existing trusted / untrusted / automaticInstallAttempted install branching
    // preserve already-resolved schema fields from state
  }
  const terminalPhase = state.schemaResolution === "ready" ? "ready" : "schema_unavailable";
  return { ...state, phase: terminalPhase, effect: undefined };
}
```

In the hook:

- Delete `schemaQuery` / `providerOptionsSchemaQueryOptions` usage and the schema-refetch `useEffect`.
- Keep status query + install mutation.
- Delete `providerSchemaRefetchEvent`.

Also delete the now-dead reducer code in the same file (removing the schema events/phases orphans it):

- `resolveSchemaAvailability` — loses all callers once `status_loaded` no longer branches on `schemaAvailable`.
- The `schema_loaded` / `schema_missing` / `schema_failed` branch inside `rejectsCompletion` — those events no longer exist.

In `provider-options-schema-service.ts`:

- Delete `providerOptionsSchemaQueryOptions`.
- Keep `providerPackageStatusQueryOptions` and `installProviderPackage`.

In `provider-options-editor.tsx`:

- Remove helper branch for `loading_schema`.
- Keep `schema_unavailable` helper copy.
- **Do not remove** the status-failure error branch. Keep:

```ts
externalInvalid={!rootValid || requiredRootMissing || schemaState.schemaResolution === "error"}
```

and FieldError when `schemaState.phase === "status_error" || schemaState.schemaResolution === "error"` using `options_schema_load_error` (after retargeted copy).

Update i18n strings as specified above; run `bun run --filter @aio-proxy/i18n build` (paraglide compile — no `i18n:compile` script exists).

`provider-form-fields-ai-sdk.tsx` only uses the hook result API (`commitPackage`, `changePackage`, `phase`, etc.) — no `schemaAvailable` field; no change required unless types break.

- [ ] **Step 4: Run tests to verify they pass**

Run: `rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/providers/components/provider-options-editor.test.ts`

Expected: PASS.

---

### Task 4: Remove server options-schema API and `schemaAvailable`

**Files:**
- Modify: `packages/server/src/dashboard-routes/provider-package-metadata.ts`
- Modify: `packages/server/src/dashboard-routes/config.ts`
- Modify: `packages/server/_test/dashboard-provider-options-schema.test.ts`
- Modify: `packages/server/package.json`
- Modify: `bun.lock`

**Interfaces:**
- `ProviderPackageStatusResponse` loses `schemaAvailable`
- Delete `ProviderOptionsSchemaResponse` and `providerPackageOptionsSchema`
- Delete route `GET /providers/options-schema`
- Server has no other runtime consumers of `@aio-proxy/provider-schemas` (`packages/core` does not import it) — remove the dependency after the route/helpers are gone.

- [ ] **Step 1: Update server tests first**

In `dashboard-provider-options-schema.test.ts`:

1. Rename/repurpose the first test: package status returns runtime fields only (no `schemaAvailable`).
2. Update installed/missing expectations to omit `schemaAvailable`.
3. Delete the two tests that hit `/providers/options-schema`.
4. Delete the `PROVIDER_OPTIONS_SCHEMAS` import.
5. Keep install confirmation tests.

Example status expectation:

```ts
expect(await response.json()).toEqual({
  npm: "@ai-sdk/openai-compatible",
  trusted: true,
  state: "bundled",
  version: BUNDLED_PROVIDER_VERSIONS["@ai-sdk/openai-compatible"],
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `rtk bun run --filter @aio-proxy/server test:unit -- _test/dashboard-provider-options-schema.test.ts`

Expected: FAIL (response still includes `schemaAvailable` / route still exists for deleted tests).

- [ ] **Step 3: Implement server removals**

`provider-package-metadata.ts`:

- Remove `@aio-proxy/provider-schemas` import.
- Remove `schemaAvailable` from the status type and both return paths.
- Delete `providerPackageOptionsSchema` and `ProviderOptionsSchemaResponse`.

`config.ts`:

- Remove the `/providers/options-schema` route and unused imports.

`packages/server/package.json`:

- Remove `"@aio-proxy/provider-schemas": "0.1.1"` once no server import remains.

Run: `rtk bun install --registry=https://registry.npmjs.org/`

- [ ] **Step 4: Run tests to verify they pass**

Run: `rtk bun run --filter @aio-proxy/server test:unit -- _test/dashboard-provider-options-schema.test.ts`

Expected: PASS.

Also confirm with a quick search:

```bash
rg "options-schema|schemaAvailable|providerPackageOptionsSchema" packages/server packages/dashboard
```

Expected: no active runtime references (docs/plans may still mention them).

---

### Task 5: End-to-end verification

**Files:**
- Verify touched packages only.

- [ ] **Step 1: Search for stale paths**

```bash
rg "options-schema|schemaAvailable|loading_schema|schema_error|providerOptionsSchemaQueryOptions|providerPackageOptionsSchema" packages docs/superpowers/specs/2026-07-16-dashboard-local-provider-options-schema-design.md
```

Expected: only the design/plan docs (and optionally historical plans) mention the removed API; no runtime code.

- [ ] **Step 2: Run unit suites**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit
rtk bun run --filter @aio-proxy/server test:unit
```

Expected: PASS.

- [ ] **Step 3: Format / lint preflight**

```bash
rtk bun run check
```

Expected: PASS (or fix only issues introduced by this change). Note: preflight does not run full `tsc`; IDE may still flag `exactOptionalPropertyTypes` issues — avoid explicit `schema: undefined` in optional props.

- [ ] **Step 4: Manual sanity (if a dashboard is running)**

1. Edit an AI SDK provider with `@ai-sdk/openai-compatible` — required fields still schema-validated.
2. Change package to `@vendor/custom-provider` — helper shows unavailable; arbitrary object JSON saves without schema markers.
3. Switch back — schema diagnostics return without leftover custom-only acceptance.
4. Force a package-status failure (invalid name / offline) — submit stays blocked **and** FieldError is visible (not silent).

---

## Spec coverage checklist

| Spec requirement | Task |
| --- | --- |
| Dashboard depends on `@aio-proxy/provider-schemas@0.1.1` main entry | Task 2 |
| Local sync schema resolution; remove HTTP schema fetch phases | Task 3 |
| Remove `schemaAvailable` from package-status | Task 4 |
| JsonEditor: no register/validate when schema undefined; clear on switch | Task 1 |
| Delete options-schema route and helpers | Task 4 |
| Drop server dependency if unused | Task 4 |
| Catalog / non-catalog / switch verification | Task 5 |
| status_error still shows blocking error copy | Task 3 |
| Bundle cost of embedding schemas acknowledged | Architecture |

## Review-response notes

Accepted from the plan review and folded in above:

1. status_error must keep visible error + `externalInvalid` (retarget i18n; no silent disable).
2. Task 3 test file: explicit delete/rewrite checklist by test name.
3. Resolver: single `providerOptionsSchema` call; keep `schema === null` for narrowing.
4. Tests: omit explicit `schema: undefined` in `mergeJsonValidation` args under `exactOptionalPropertyTypes`.
5. Prefer `rtk bun run`; note lockfile cache for install; note ~70KB schema bundle tradeoff.
6. Explicit: `providerOptionsAreValid` logic stays; `provider-form-fields-ai-sdk.tsx` needs no field edits.
