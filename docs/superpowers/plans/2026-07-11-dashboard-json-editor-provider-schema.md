# Dashboard JSON Editor and Provider Options Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a schema-aware Monaco JSON editor to the dashboard provider form and serve build-time-generated option schemas for an explicit provider package allowlist without adding declaration parsers to the standalone binary.

**Architecture:** A new `@aio-proxy/provider-schemas` workspace package uses an Rslib `api.transform` plugin, a declaration-only npm-latest tarball cache, Babel TypeScript AST, and TypeBox Script to generate a runtime-only schema map for the explicit provider catalog directly into `dist`. The server exposes pure package-status/schema lookup routes and retains npm installation as a separate command with an `@ai-sdk/**` trust rule. The dashboard layers a reusable `JsonEditor` over `CodeEditor`, then adapts it to TanStack Form provider options.

**Tech Stack:** Bun 1.3.14, TypeScript 6, Rslib/Rsbuild, `@babel/parser` 7.28.5, `typebox` 1.3.6, Hono, React 19, Monaco Editor, TanStack Query/Form, Zod, Base UI, i18n.

## Global Constraints

- The provider configuration file format does not change.
- Zod remains the business/API validation source; TypeBox is build-only.
- `@babel/parser`, `typebox`, `tar`, registry/cache modules, and allowlisted provider packages must not enter the runtime dependency graph of the compiled CLI.
- The schema allowlist is the versionless package/factory catalog in `packages/provider-schemas/src/allowlist.ts`.
- Allowlisted providers are not package dependencies. One-shot builds resolve public npm `latest`; watch builds reuse the newest valid cached registry observation and access npm only on cache miss.
- Bundled package-status versions remain the actual core runtime dependency versions; options-schema versions separately identify the npm-latest declaration source.
- The runtime trust rule is exactly `new Bun.Glob("@ai-sdk/**")` and is enforced by the server.
- Trusted missing packages install only after package-name blur or Enter; typing alone has no side effects.
- Unknown schema properties remain allowed.
- Loaded schema errors block Save; warnings do not.
- Missing schemas degrade to JSON syntax plus root-object validation.
- All dashboard copy is defined in both `packages/i18n/messages/en.json` and `packages/i18n/messages/zh-Hans.json`.
- Do not edit `packages/dashboard/src/route-tree.gen.ts`.
- Use `rtk` for shell verification commands.
- Every commit message ends with `Co-authored-by: Codex <noreply@openai.com>`.

---

## File Map

### New provider schemas package

- `packages/provider-schemas/package.json` — workspace scripts, dist exports, and build-only parser/archive dependencies; no allowlisted provider dependencies.
- `packages/provider-schemas/tsconfig.json` — runtime source compilation settings.
- `packages/provider-schemas/scripts/tsconfig.json` — build generator settings outside the runtime source tree.
- `packages/provider-schemas/rslib.config.ts` — Rslib config plus the build-only transform plugin.
- `packages/provider-schemas/src/types.ts` — project-owned runtime schema entry types.
- `packages/provider-schemas/src/allowlist.ts` — exact `{ packageName, factoryName }` generation list.
- `packages/provider-schemas/src/schema-module.ts` — empty typed physical module transformed to generated data during builds.
- `packages/provider-schemas/src/index.ts` — runtime-only lookup API.
- `packages/provider-schemas/scripts/declaration-entry.ts` — safe package/declaration entrypoint resolution.
- `packages/provider-schemas/scripts/declaration-parser.ts` — Babel AST extraction, relative declaration traversal, and JSDoc collection.
- `packages/provider-schemas/scripts/schema-normalizer.ts` — TypeBox result normalization and warning policy.
- `packages/provider-schemas/scripts/provider-schemas-generator.ts` — allowlist orchestration and deterministic source rendering.
- `packages/provider-schemas/scripts/provider-source-cache.ts` — verified npm-latest metadata, declaration-only tarball extraction, and immutable local observations.
- `packages/provider-schemas/scripts/provider-schemas-build.ts` — build-context package resolution entrypoint loaded by the transform.
- `packages/provider-schemas/scripts/provider-schemas-plugin.ts` — build-only transform and dependency registration.
- `packages/provider-schemas/_test/declaration-parser.test.ts` — parser/path/traversal tests.
- `packages/provider-schemas/_test/schema-generator.test.ts` — conversion, JSDoc, allowlist, transform, dist-output, and runtime-bundle tests.

### Server

- `packages/server/package.json` — runtime dependency on `@aio-proxy/provider-schemas`.
- `packages/server/src/provider-package-trust.ts` — server-owned Bun glob trust predicate.
- `packages/server/src/dashboard-routes/provider-package-metadata.ts` — package status and embedded schema lookup handlers.
- `packages/server/src/dashboard-routes/config.ts` — route wiring and trusted install confirmation policy.
- `packages/server/_test/dashboard-provider-options-schema.test.ts` — status/schema/trust/install route tests.

### Dashboard foundation

- `packages/dashboard/src/components/code-editor/code-editor.tsx` — focus/invalid wrapper API and composed Monaco callbacks.
- `packages/dashboard/src/components/code-editor/code-editor.module.css` — Input-aligned focus/invalid styling.
- `packages/dashboard/src/components/json-editor/json-editor-state.ts` — pure JSON draft parsing and validation state helpers.
- `packages/dashboard/src/components/json-editor/json-schema-registry.ts` — global Monaco JSON schema registration registry.
- `packages/dashboard/src/components/json-editor/json-editor.tsx` — reusable raw-draft-owning Monaco JSON editor.
- `packages/dashboard/src/components/json-editor/index.tsx` — public exports.
- `packages/dashboard/_test/json-editor.test.ts` — parsing, validation merge, schema registry, and source wiring tests.

### Dashboard provider integration

- `packages/dashboard/src/modules/providers/services/provider-options-schema-service.ts` — typed Hono package status/schema/install requests.
- `packages/dashboard/src/modules/providers/hooks/use-provider-options-schema.ts` — committed package workflow, trusted auto-install, and stale-response isolation.
- `packages/dashboard/src/modules/providers/components/provider-options-editor.tsx` — TanStack Form adapter, status UI, and untrusted install dialog.
- `packages/dashboard/src/modules/providers/components/provider-form-fields-ai-sdk.tsx` — package commit triggers and editor replacement.
- `packages/dashboard/src/modules/providers/templates/provider-form-page.tsx` — renamed options validity state only if required by the adapter API.
- Delete `packages/dashboard/src/modules/providers/components/provider-options-textarea.tsx`.
- `packages/dashboard/_test/provider-options-editor.test.ts` — provider workflow and component wiring tests.
- `packages/i18n/messages/en.json` and `packages/i18n/messages/zh-Hans.json` — schema/install/status/error copy.

---

### Task 1: Scaffold `@aio-proxy/provider-schemas` and resolve declaration inputs

**Files:**
- Create: `packages/provider-schemas/package.json`
- Create: `packages/provider-schemas/tsconfig.json`
- Create: `packages/provider-schemas/scripts/tsconfig.json`
- Create: `packages/provider-schemas/src/types.ts`
- Create: `packages/provider-schemas/src/allowlist.ts`
- Create: `packages/provider-schemas/src/index.ts`
- Create: `packages/provider-schemas/src/schema-module.ts`
- Create: `packages/provider-schemas/scripts/declaration-entry.ts`
- Create: `packages/provider-schemas/scripts/declaration-parser.ts`
- Create: `packages/provider-schemas/_test/declaration-parser.test.ts`
- Modify: `bun.lock`

**Interfaces:**
- Produces: `PROVIDER_SCHEMA_ALLOWLIST`, `ProviderSchemaAllowlistEntry`, `ProviderOptionsSchemaEntry`, `ProviderOptionsSchemaWarning`, `resolveDeclarationEntry()`, and `parseProviderFactoryDeclaration()`.
- Consumes: package metadata from allowlisted packages only; no runtime package imports.

- [ ] **Step 1: Write declaration resolver and parser tests**

Create fixtures inside the test's temporary directory and assert the public contracts:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProviderFactoryDeclaration } from "../scripts/declaration-parser";
import { resolveDeclarationEntry } from "../scripts/declaration-entry";

describe("provider schema declaration inputs", () => {
  test("resolves exports.types before types and typings", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-schema-entry-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "fixture-provider",
      version: "1.0.0",
      types: "./fallback.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    }));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/index.d.ts"), "export declare function createFixture(options: { apiKey?: string }): unknown;\n");

    expect(await resolveDeclarationEntry(root)).toBe(join(root, "dist/index.d.ts"));
  });

  test("extracts the configured factory parameter and JSDoc", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-schema-parser-"));
    const entry = join(root, "index.d.ts");
    writeFileSync(entry, `
      export interface FixtureSettings {
        /** API key used for authentication. */
        apiKey?: string;
      }
      export declare function createFixture(options?: FixtureSettings): unknown;
    `);

    const parsed = await parseProviderFactoryDeclaration({
      packageRoot: root,
      declarationEntry: entry,
      factoryName: "createFixture",
    });

    expect(parsed.parameterType).toBe("FixtureSettings");
    expect(parsed.optional).toBe(true);
    expect(parsed.documentation["FixtureSettings.apiKey"]).toBe("API key used for authentication.");
  });
});
```

- [ ] **Step 2: Run the tests and verify the package does not exist yet**

Run:

```bash
rtk bun test ./packages/provider-schemas/_test/declaration-parser.test.ts
```

Expected: FAIL because the package modules do not exist.

- [ ] **Step 3: Add the package manifest and build-only dependencies**

Create `package.json` with dist-only runtime exports, an Rslib watch task, and build-only generator dependencies under `devDependencies`. Allowlisted provider packages are resolved from verified npm tarballs and are not dependencies:

```json
{
  "name": "@aio-proxy/provider-schemas",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "rslib",
    "dev": "rslib --watch --no-clean",
    "test": "bun run test:unit",
    "test:unit": "cd ../.. && bun test packages/provider-schemas/_test/*.test.ts"
  },
  "devDependencies": {
    "@aio-proxy/infra": "workspace:*",
    "@babel/parser": "7.28.5",
    "@rslib/core": "catalog:",
    "@types/bun": "catalog:",
    "typebox": "1.3.6",
    "typescript": "catalog:",
    "tar": "^7.5.19"
  }
}
```

Run `bun install` to update `bun.lock`.

- [ ] **Step 4: Add runtime-owned types and exact allowlist**

Define types without importing Babel or TypeBox:

```ts
export type JsonSchema = Readonly<Record<string, unknown>>;

export type ProviderOptionsSchemaWarning = {
  readonly code: "unsupported_optional" | "unresolved_optional";
  readonly path: string;
};

export type ProviderOptionsSchemaEntry = {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly factoryName: string;
  readonly schema: JsonSchema | null;
  readonly warnings: readonly ProviderOptionsSchemaWarning[];
};
```

Define the versionless allowlist exactly in `src/allowlist.ts` as `{ packageName, factoryName }` entries. The source file is the catalog authority; do not duplicate versions or provider dependencies in `package.json`.

Initialize `schema-module.ts` with `export const PROVIDER_OPTIONS_SCHEMAS: Readonly<Record<string, ProviderOptionsSchemaEntry>> = {};` as the physical transform input. Export lookup helpers from `index.ts`:

```ts
import { PROVIDER_OPTIONS_SCHEMAS } from "./schema-module";

export const providerOptionsSchema = (packageName: string) => {
  const entry = PROVIDER_OPTIONS_SCHEMAS[packageName];
  return entry?.schema === null ? undefined : entry;
};
export const hasProviderOptionsSchema = (packageName: string) => providerOptionsSchema(packageName) !== undefined;
export { PROVIDER_SCHEMA_ALLOWLIST } from "./allowlist";
export type { JsonSchema, ProviderOptionsSchemaEntry, ProviderOptionsSchemaWarning } from "./types";
```

- [ ] **Step 5: Implement safe declaration entrypoint resolution**

Implement `resolveDeclarationEntry(packageRoot)` by parsing `package.json` with Zod-free local guards, preferring `exports["."].types`, then `types`, then `typings`. Resolve the candidate against `packageRoot`, call `realpath`, and reject candidates outside `packageRoot` using `relative()` path checks. Return the absolute `.d.ts` path and expose the parsed package version through a companion `readProviderPackageMetadata()` function.

- [ ] **Step 6: Implement Babel declaration parsing and bounded relative traversal**

Expose this exact result shape:

```ts
export type ParsedProviderFactoryDeclaration = {
  readonly parameterType: string;
  readonly optional: boolean;
  readonly declarations: readonly string[];
  readonly documentation: Readonly<Record<string, string>>;
};
```

Use `parse(source, { sourceType: "module", plugins: ["typescript"] })`. Locate exported `TSDeclareFunction`/`FunctionDeclaration` or an exported variable with a callable type annotation, preserving the first public overload. Follow only relative import/re-export sources, preserve local type aliases in the self-contained output, enforce 64 files, depth 16, and 4 MiB total source, and keep a `Set` of real paths. Use Babel `start`/`end` offsets to preserve declaration text and `leadingComments` to normalize JSDoc. Collect referenced local type/interface declarations recursively; leave bare-package references unresolved for Task 2 policy handling.

- [ ] **Step 7: Run the focused tests**

Run:

```bash
rtk bun test ./packages/provider-schemas/_test/declaration-parser.test.ts
```

Expected: PASS, including path escape, re-export, cycle, and limit cases added alongside implementation.

- [ ] **Step 8: Commit Task 1**

```bash
rtk git add packages/provider-schemas bun.lock
rtk git commit -m "feat(provider-schemas): parse provider declarations" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Generate and package the allowlisted build-time option schemas

**Files:**
- Create: `packages/provider-schemas/scripts/schema-normalizer.ts`
- Create: `packages/provider-schemas/scripts/provider-schemas-generator.ts`
- Create: `packages/provider-schemas/scripts/provider-schemas-build.ts`
- Create: `packages/provider-schemas/scripts/provider-schemas-plugin.ts`
- Create: `packages/provider-schemas/rslib.config.ts`
- Create: `packages/provider-schemas/_test/schema-generator.test.ts`
- Modify: `packages/provider-schemas/src/schema-module.ts`
- Modify: `packages/provider-schemas/src/index.ts`

**Interfaces:**
- Consumes: Task 1 declaration parser, allowlist, and runtime entry types.
- Produces: `generateProviderSchemaEntries()`, `renderGeneratedProviderSchemas()`, dist-only `PROVIDER_OPTIONS_SCHEMAS`, and runtime lookup helpers with no build-tool imports.

- [ ] **Step 1: Write failing normalization and transform tests**

Cover JSON-compatible conversion policy and the real allowlist:

```ts
import { describe, expect, test } from "bun:test";
import { normalizeTypeBoxModule } from "../scripts/schema-normalizer";
import { generateProviderSchemaEntries } from "../scripts/provider-schemas-build";
import { renderGeneratedProviderSchemas } from "../scripts/provider-schemas-generator";

describe("provider schema generation", () => {
  test("drops optional functions but rejects required functions", () => {
    const optional = normalizeTypeBoxModule({
      rootName: "Options",
      module: {
        Options: { type: "object", properties: { fetch: { type: "function" } } },
      },
      documentation: {},
    });
    expect(optional.schema).toEqual({ type: "object", additionalProperties: true, properties: {} });
    expect(optional.warnings).toEqual([{ code: "unsupported_optional", path: "fetch" }]);

    const required = normalizeTypeBoxModule({
      rootName: "Options",
      module: {
        Options: { type: "object", required: ["fetch"], properties: { fetch: { type: "function" } } },
      },
      documentation: {},
    });
    expect(required.schema).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

```bash
rtk bun test ./packages/provider-schemas/_test/schema-generator.test.ts
```

Expected: FAIL because the normalizer/generator modules and transform behavior do not exist yet.

- [ ] **Step 3: Implement TypeBox Script conversion**

Build a self-contained module string from Task 1 declarations plus:

```ts
export type __AioProxyProviderOptions = NonNullable<FACTORY_PARAMETER_TYPE>;
```

Call `Script(moduleSource)` from `typebox`, extract `__AioProxyProviderOptions`, and pass the module plus documentation map to `normalizeTypeBoxModule()`.

Normalization must recursively:

1. create `$defs` for referenced module declarations and rewrite local refs to `#/$defs/<name>`;
2. set `additionalProperties: true` on every object schema;
3. treat `{ type: "function" }`, symbol/bigint/undefined, and unresolved refs as unsupported;
4. remove unsupported optional properties and record deterministic dot paths;
5. return `schema: null` when an unsupported property is required; and
6. attach declaration/property JSDoc to matching schema nodes as `description`.

- [ ] **Step 4: Implement deterministic generation and source rendering**

`generateProviderSchemaEntries()` iterates `PROVIDER_SCHEMA_ALLOWLIST` in source order. For each entry, resolve public npm `dist-tags.latest` through the verified declaration-only cache, parse `entry.factoryName`, convert it, and include the resolved package version. One-shot builds refresh latest on every build; watch builds reuse the newest valid cached observation. Output can therefore change when npm latest changes.

Render only serializable data:

```ts
export function renderGeneratedProviderSchemas(entries: Readonly<Record<string, ProviderOptionsSchemaEntry>>): string {
  const serialized = JSON.stringify(sortSchemaRecord(entries), null, 2);
  return [
    'import type { ProviderOptionsSchemaEntry } from "./types";',
    "",
    `export const PROVIDER_OPTIONS_SCHEMAS = ${serialized} as const satisfies Readonly<Record<string, ProviderOptionsSchemaEntry>>;`,
    "",
  ].join("\n");
}
```

Sort object keys and warning paths before `JSON.stringify(..., null, 2)` so repeated generation is byte-identical.

- [ ] **Step 5: Add the Rslib module transform plugin**

Create a build-only plugin that targets the physical schema module and loads the generator through transform context:

```ts
import { join } from "node:path";
import type { RsbuildPlugin } from "@aio-proxy/infra/rslib";

export const pluginProviderSchemas = (): RsbuildPlugin => ({
  name: "aio-proxy:provider-schemas",
  apply: "build",
  setup(api) {
    api.transform(
      { test: join(api.context.rootPath, "src/schema-module.ts"), order: "pre" },
      async ({ addDependency, importModule }) => {
        const generator = await importModule(join(api.context.rootPath, "scripts/provider-schemas-build.ts"));
        const generated = await generator.generateProviderSchemaEntries(addDependency);
        return generator.renderGeneratedProviderSchemas(generated.entries);
      },
    );
  },
});
```

The transform never writes source and always returns the generated module for compilation into `dist`.

- [ ] **Step 6: Build generated dist output and run package tests**

```bash
rtk bun run --filter @aio-proxy/provider-schemas build
rtk bun test ./packages/provider-schemas/_test/*.test.ts
```

Expected: build succeeds, `dist` contains every current allowlist entry, `src/schema-module.ts` remains empty, and tests pass. Add assertions that the generated keys exactly equal the allowlist, each entry records a non-empty resolved version, `@ai-sdk/openai-compatible` requires `name` and `baseURL`, and JSDoc descriptions appear on known fields.

- [ ] **Step 7: Prove runtime output contains no build-only imports**

```bash
rtk rg -n "from [\\\"'](@babel/parser|typebox)|require\\([\\\"'](@babel/parser|typebox)" packages/provider-schemas/dist
```

Expected: no matches in runtime JavaScript.

- [ ] **Step 8: Commit Task 2**

```bash
rtk git add packages/provider-schemas
rtk git commit -m "feat(provider-schemas): generate provider option schemas" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Expose package status, embedded schemas, and trusted install policy

**Files:**
- Modify: `packages/server/package.json`
- Create: `packages/server/src/provider-package-trust.ts`
- Create: `packages/server/src/dashboard-routes/provider-package-metadata.ts`
- Modify: `packages/server/src/dashboard-routes/config.ts`
- Create: `packages/server/_test/dashboard-provider-options-schema.test.ts`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: `providerOptionsSchema()`, `hasProviderOptionsSchema()`, `BUNDLED_PROVIDER_PACKAGES`, `findInstalledNpmPackage()`, and `npmAdd()`.
- Produces: `GET /dashboard/api/providers/package-status`, `GET /dashboard/api/providers/options-schema`, and trusted/untrusted install validation.

- [ ] **Step 1: Write failing route tests**

Create tests for pure lookup and trust policy:

```ts
test("package status separates runtime state from embedded schema availability", async () => {
  const app = createServer({ config: { providers: {} } });
  const response = await app.request(
    "/dashboard/api/providers/package-status?npm=%40ai-sdk%2Fopenai-compatible",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    npm: "@ai-sdk/openai-compatible",
    trusted: true,
    state: "bundled",
    schemaAvailable: true,
  });
});

test("returns embedded schema without importing provider code", async () => {
  const app = createServer({ config: { providers: {} } });
  const response = await app.request(
    "/dashboard/api/providers/options-schema?npm=%40ai-sdk%2Fopenai-compatible",
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.factoryName).toBe("createOpenAICompatible");
  expect(body.schema.required).toEqual(expect.arrayContaining(["name", "baseURL"]));
});
```

Add tests for invalid names, schema 404, missing trusted install without `confirmed`, and missing untrusted install requiring `confirmed: true`.

- [ ] **Step 2: Run the focused server test and verify failure**

```bash
rtk bun test ./packages/server/_test/dashboard-provider-options-schema.test.ts
```

Expected: FAIL with missing routes/dependency.

- [ ] **Step 3: Add the runtime dependency and trust helper**

Add `"@aio-proxy/provider-schemas": "workspace:*"` to server dependencies and run `bun install`.

Implement:

```ts
const trustedProviderPackages = [new Bun.Glob("@ai-sdk/**")];

export const isTrustedProviderPackage = (packageName: string): boolean =>
  trustedProviderPackages.some((glob) => glob.match(packageName));
```

- [ ] **Step 4: Implement pure metadata handlers**

Use local Zod query schemas and return these exact JSON shapes:

```ts
type ProviderPackageStatusResponse = {
  npm: string;
  trusted: boolean;
  state: "bundled" | "installed" | "missing";
  version?: string;
  schemaAvailable: boolean;
};

type ProviderOptionsSchemaResponse = {
  npm: string;
  packageVersion: string;
  factoryName: string;
  schema: Readonly<Record<string, unknown>>;
  warnings: readonly { code: string; path: string }[];
};
```

Bundled detection checks `BUNDLED_PROVIDER_PACKAGES` and uses the embedded schema entry for the bundled version; installed detection calls `findInstalledNpmPackage`; schema availability is always a pure lookup in `@aio-proxy/provider-schemas`.

- [ ] **Step 5: Wire GET routes and update install confirmation policy**

Change install request validation to accept optional confirmation, then enforce:

```ts
if (!isTrustedProviderPackage(request.npm) && request.confirmed !== true) {
  return context.json({ code: "confirmation_required", error: "provider install requires confirmation" }, 400);
}
```

Keep the existing CSRF middleware, npm name validation, lock handling, registry override support, and install error status codes.

- [ ] **Step 6: Run server tests**

```bash
rtk bun test ./packages/server/_test/dashboard-provider-options-schema.test.ts ./packages/server/_test/server.test.ts
```

Expected: PASS; existing install tests remain green after updating their expected structured error where necessary.

- [ ] **Step 7: Commit Task 3**

```bash
rtk git add packages/server bun.lock
rtk git commit -m "feat(server): expose provider option schemas" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Align CodeEditor styling and build reusable JsonEditor

**Files:**
- Modify: `packages/dashboard/src/components/code-editor/code-editor.tsx`
- Modify: `packages/dashboard/src/components/code-editor/code-editor.module.css`
- Create: `packages/dashboard/src/components/json-editor/json-editor-state.ts`
- Create: `packages/dashboard/src/components/json-editor/json-schema-registry.ts`
- Create: `packages/dashboard/src/components/json-editor/json-editor.tsx`
- Create: `packages/dashboard/src/components/json-editor/index.tsx`
- Create: `packages/dashboard/_test/json-editor.test.ts`

**Interfaces:**
- Produces: `JsonValue`, `JsonSchema`, `JsonEditorValidation`, `parseJsonDraft()`, `registerJsonSchema()`, and `<JsonEditor />`.
- Consumes: Monaco Editor callbacks and CodeEditor wrapper only.

- [ ] **Step 1: Write failing pure-state and registry tests**

```ts
import { describe, expect, test } from "bun:test";
import { mergeJsonValidation, parseJsonDraft } from "../src/components/json-editor/json-editor-state";
import { createJsonSchemaRegistry } from "../src/components/json-editor/json-schema-registry";

describe("JsonEditor state", () => {
  test("distinguishes empty, null, valid JSON, and invalid JSON", () => {
    expect(parseJsonDraft("   ")).toEqual({ ok: true, value: undefined });
    expect(parseJsonDraft("null")).toEqual({ ok: true, value: null });
    expect(parseJsonDraft('{"x":1}')).toEqual({ ok: true, value: { x: 1 } });
    expect(parseJsonDraft("{").ok).toBe(false);
  });

  test("schema errors invalidate while warnings do not", () => {
    expect(mergeJsonValidation({ syntaxValid: true, markers: [{ severity: "warning" }] }).valid).toBe(true);
    expect(mergeJsonValidation({ syntaxValid: true, markers: [{ severity: "error" }] }).valid).toBe(false);
  });

  test("registry preserves other mounted editor schemas", () => {
    const applied: unknown[] = [];
    const registry = createJsonSchemaRegistry((schemas) => applied.push(schemas));
    const removeA = registry.set("a", { uri: "schema:a", fileMatch: ["model:a"], schema: { type: "object" } });
    registry.set("b", { uri: "schema:b", fileMatch: ["model:b"], schema: { type: "array" } });
    removeA();
    expect(applied.at(-1)).toEqual([{ uri: "schema:b", fileMatch: ["model:b"], schema: { type: "array" } }]);
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

```bash
rtk bun test ./packages/dashboard/_test/json-editor.test.ts
```

Expected: FAIL because JsonEditor modules do not exist.

- [ ] **Step 3: Implement pure JSON parsing and validation merge**

Define recursive JSON types and return discriminated parse results. Convert Monaco marker severities to project-owned `"error" | "warning"` values before merging, so tests do not need Monaco runtime imports.

- [ ] **Step 4: Implement the global Monaco schema registry**

The registry owns a `Map<string, SchemaRegistration>` and calls:

```ts
monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
  validate: true,
  allowComments: false,
  trailingCommas: "error",
  schemas: [...entries.values()],
});
```

Registration returns an idempotent cleanup function. Updating one editor never removes another editor's entry.

- [ ] **Step 5: Align CodeEditor wrapper styling with Input**

Add a CodeEditor-only `invalid?: boolean` prop, apply `aria-invalid`, and move the shared control visuals to the wrapper. The resulting CSS must contain the semantic equivalents of:

```css
.code-editor {
  @apply w-full rounded-3xl border border-transparent bg-input/50 transition-[color,box-shadow,background-color] outline-none;
}
.code-editor:focus-within {
  @apply border-ring ring-3 ring-ring/30;
}
.code-editor[aria-invalid="true"] {
  @apply border-destructive ring-3 ring-destructive/20 dark:border-destructive/50 dark:ring-destructive/40;
}
```

Keep Monaco/overflow-guard backgrounds transparent and rounded.

- [ ] **Step 6: Implement JsonEditor raw draft ownership**

Expose:

```ts
export type JsonEditorProps = {
  readonly value: JsonValue | undefined;
  readonly schema?: JsonSchema;
  readonly onValueChange: (value: JsonValue | undefined) => void;
  readonly onValidationChange?: (validation: JsonEditorValidation) => void;
  readonly id?: string;
  readonly className?: string;
  readonly height?: string | number;
};
```

Use a stable `useId()`-derived `inmemory://aio-proxy/json-editor/<id>.json` model URI. Keep `draft` state separate from parsed `value`; do not emit on invalid JSON. Record the last emitted value reference so the controlled prop effect does not reformat every valid keystroke. Register/unregister schema after Monaco mount, set `language="json"`, pass `path=modelUri`, and merge synchronous parse state with `onValidate` markers. When a new schema is registered, report pending/invalid until Monaco emits validation markers.

- [ ] **Step 7: Run JsonEditor tests and dashboard build**

```bash
rtk bun test ./packages/dashboard/_test/json-editor.test.ts
rtk bun run --filter @aio-proxy/dashboard build
```

Expected: PASS and successful build.

- [ ] **Step 8: Commit Task 4**

```bash
rtk git add packages/dashboard/src/components packages/dashboard/_test/json-editor.test.ts
rtk git commit -m "feat(dashboard): add schema-aware json editor" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Add dashboard package/schema services and committed-name workflow

**Files:**
- Create: `packages/dashboard/src/modules/providers/services/provider-options-schema-service.ts`
- Create: `packages/dashboard/src/modules/providers/hooks/use-provider-options-schema.ts`
- Create: `packages/dashboard/_test/provider-options-editor.test.ts`

**Interfaces:**
- Consumes: Task 3 Hono routes and TanStack Query.
- Produces: `providerPackageStatusQueryOptions()`, `providerOptionsSchemaQueryOptions()`, `installProviderPackage()`, and `useProviderOptionsSchema()`.

- [ ] **Step 1: Write failing service/workflow source tests**

Because the dashboard test setup currently favors pure/source tests, assert service query keys and extract the workflow reducer as a pure helper:

```ts
test("package change clears schema before the next commit", () => {
  expect(providerOptionsSchemaTransition(
    { committedPackage: "@ai-sdk/openai", schemaPackage: "@ai-sdk/openai" },
    { type: "package_changed", packageName: "@ai-sdk/google" },
  )).toMatchObject({ committedPackage: null, schemaPackage: null });
});

test("trusted missing packages request automatic install", () => {
  expect(providerOptionsSchemaTransition(
    { committedPackage: "@ai-sdk/google", schemaPackage: null },
    { type: "status_loaded", status: { trusted: true, state: "missing", schemaAvailable: true } },
  ).effect).toEqual({ type: "install", confirmed: false });
});
```

- [ ] **Step 2: Run the test and verify failure**

```bash
rtk bun test ./packages/dashboard/_test/provider-options-editor.test.ts
```

Expected: FAIL because service/hook modules do not exist.

- [ ] **Step 3: Implement typed Hono service functions**

Use `createDashboardClient()` only in the service file. Query keys must include the package name:

```ts
["providers", "package-status", packageName]
["providers", "options-schema", packageName]
```

Throw a project-local `ProviderPackageRequestError` containing HTTP status and response `code`. Install uses the existing POST route and sends `{ npm }` for trusted automatic installation or `{ npm, confirmed: true }` after untrusted confirmation; it never sends `confirmed: false` or provider options.

- [ ] **Step 4: Implement pure workflow transitions**

Model these states explicitly:

```ts
type ProviderOptionsSchemaPhase =
  | "idle"
  | "checking"
  | "installing"
  | "install_required"
  | "loading_schema"
  | "ready"
  | "schema_unavailable"
  | "install_error";
```

Events include `package_changed`, `package_committed`, `status_loaded`, `install_succeeded`, `install_failed`, `schema_loaded`, and `schema_missing`. Every async completion includes its package name; ignore events whose package differs from the currently committed package.

- [ ] **Step 5: Implement the React Query hook**

Expose:

```ts
type UseProviderOptionsSchemaResult = {
  readonly phase: ProviderOptionsSchemaPhase;
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly warnings: readonly { code: string; path: string }[];
  readonly packageName: string | null;
  readonly changePackage: (packageName: string) => void;
  readonly commitPackage: (packageName: string) => void;
  readonly confirmInstall: () => void;
  readonly errorCode?: string;
};
```

The hook owns only the package/schema workflow. On a trusted missing status it calls install automatically once per committed package. On successful install it invalidates/refetches status. If `schemaAvailable` is true it enables the pure schema query; otherwise it enters `schema_unavailable`. Use an attempted-package ref or mutation key to prevent repeated automatic installs.

- [ ] **Step 6: Run focused dashboard tests**

```bash
rtk bun test ./packages/dashboard/_test/provider-options-editor.test.ts
```

Expected: PASS for trusted auto-install, untrusted confirmation, package-change clearing, and stale response cases.

- [ ] **Step 7: Commit Task 5**

```bash
rtk git add packages/dashboard/src/modules/providers/services packages/dashboard/src/modules/providers/hooks packages/dashboard/_test/provider-options-editor.test.ts
rtk git commit -m "feat(dashboard): load provider option schemas" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Replace provider options textarea and add localized install/schema UX

**Files:**
- Create: `packages/dashboard/src/modules/providers/components/provider-options-editor.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/provider-form-fields-ai-sdk.tsx`
- Modify: `packages/dashboard/src/modules/providers/templates/provider-form-page.tsx`
- Delete: `packages/dashboard/src/modules/providers/components/provider-options-textarea.tsx`
- Modify: `packages/dashboard/_test/provider-options-editor.test.ts`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Generated by build: `packages/i18n/src/paraglide/*`

**Interfaces:**
- Consumes: Task 4 `<JsonEditor />` and Task 5 `useProviderOptionsSchema()`.
- Produces: provider form with schema-aware options, trusted blur/Enter commit, untrusted install confirmation, and Save validity integration.

- [ ] **Step 1: Extend failing component wiring assertions**

Read component sources as existing dashboard tests do and assert:

```ts
expect(aiSdkFieldsSource).toContain("useProviderOptionsSchema");
expect(aiSdkFieldsSource).toContain("onBlur");
expect(aiSdkFieldsSource).toContain('event.key === "Enter"');
expect(optionsEditorSource).toContain("<JsonEditor");
expect(optionsEditorSource).toContain("AlertDialog");
expect(optionsEditorSource).not.toContain("Textarea");
```

Add pure tests that `undefined`, arrays, primitives, and `null` fail provider root-object validation while plain objects pass.

- [ ] **Step 2: Run the test and verify failure**

```bash
rtk bun test ./packages/dashboard/_test/provider-options-editor.test.ts
```

Expected: FAIL because the provider form still uses `ProviderOptionsTextarea`.

- [ ] **Step 3: Add localized copy**

Add matching keys in both locales for:

- invalid JSON;
- options must be an object;
- checking package;
- installing trusted package;
- install provider package;
- install confirmation title/description/confirm/cancel;
- schema unavailable;
- schema warning summary;
- install failure; and
- schema loading.

Use complete Chinese translations; do not leave untranslated marker text.

Compile messages:

```bash
rtk bun run --filter @aio-proxy/i18n build
```

- [ ] **Step 4: Implement ProviderOptionsEditor**

Props:

```ts
type Props = {
  readonly field: AnyFieldApi;
  readonly schemaState: UseProviderOptionsSchemaResult;
  readonly onValidityChange: (valid: boolean) => void;
};
```

Render `Field`, `Label`, `JsonEditor`, status/helper copy, `FieldError`, and one controlled `AlertDialog` for `install_required`. Parse editor values through a pure `isProviderOptionsObject()` guard before calling `field.handleChange`. Combine root-object validity with JsonEditor validity and call `onValidityChange` only when the boolean changes.

- [ ] **Step 5: Commit package names on blur/Enter and clear schema on change**

In `ProviderFormFieldsAiSdk`, create the workflow once. Package input behavior:

```tsx
onChange={(event) => {
  field.handleChange(event.target.value);
  schemaState.changePackage(event.target.value);
}}
onBlur={() => schemaState.commitPackage(field.state.value ?? DEFAULT_AI_SDK_PACKAGE)}
onKeyDown={(event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    schemaState.commitPackage(field.state.value ?? DEFAULT_AI_SDK_PACKAGE);
  }
}}
```

Initialize the committed package to the visible default/current package so edit pages and new default forms load an embedded schema without requiring a manual package edit.

- [ ] **Step 6: Replace textarea and preserve Save blocking semantics**

Delete `ProviderOptionsTextarea`. Pass `schemaState` to `ProviderOptionsEditor`. Keep `ProviderFormPage`'s validity gate, renaming `optionsJsonValid` to `optionsValid` so it reflects syntax, root object, and loaded schema errors.

- [ ] **Step 7: Run dashboard/i18n tests and build**

```bash
rtk bun test ./packages/dashboard/_test/json-editor.test.ts ./packages/dashboard/_test/provider-options-editor.test.ts
rtk bun run --filter @aio-proxy/i18n build
rtk bun run --filter @aio-proxy/dashboard build
```

Expected: all tests pass and dashboard builds.

- [ ] **Step 8: Commit Task 6**

```bash
rtk git add packages/dashboard packages/i18n
rtk git commit -m "feat(dashboard): validate provider options with json schema" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 7: Verify the runtime dependency boundary and complete browser QA

**Files:**
- Modify only if verification finds defects in files from Tasks 1–6.

**Interfaces:**
- Consumes: complete implementation.
- Produces: verified package generation, server API, dashboard behavior, runtime dependency boundary, and visual acceptance evidence.

- [ ] **Step 1: Run all focused automated checks**

```bash
rtk bun test ./packages/provider-schemas/_test/*.test.ts
rtk bun test ./packages/server/_test/dashboard-provider-options-schema.test.ts ./packages/server/_test/server.test.ts
rtk bun test ./packages/dashboard/_test/json-editor.test.ts ./packages/dashboard/_test/provider-options-editor.test.ts
rtk bun run --filter @aio-proxy/provider-schemas build
rtk bun run --filter @aio-proxy/i18n build
rtk bun run --filter @aio-proxy/dashboard build
rtk bun run check
```

Expected: all commands exit 0.

- [ ] **Step 2: Bundle the runtime graph to a temporary file and inspect dependency leakage**

Bundle the CLI source graph without touching tracked npm binaries:

```bash
rtk bun build packages/cli/src/main.ts --target=bun --outfile=/tmp/aio-proxy-runtime-check.js
rtk rg -n '@babel/parser|typebox/build/type/script' /tmp/aio-proxy-runtime-check.js
```

Expected: bundle succeeds and the search has no matches. Generated schema JSON may appear, but parser/compiler code must not.

- [ ] **Step 3: Start the real dashboard and perform browser QA**

Run the real server/dashboard workflow, then use the browser automation skill to verify:

1. focusing CodeEditor produces the same border/ring as Input;
2. invalid state uses destructive styling;
3. `@ai-sdk/openai-compatible` provides completion for `name`, `baseURL`, and other fields;
4. hover displays generated JSDoc;
5. missing required/type-invalid values disable Save;
6. warnings do not disable Save;
7. a package outside the schema allowlist remains editable with object JSON;
8. changing package name preserves options and immediately removes the old schema;
9. trusted missing packages install only after blur or Enter; and
10. untrusted missing packages require confirmation.

- [ ] **Step 4: Run the repository preflight**

```bash
rtk bun run preflight
```

Expected: exit 0.

- [ ] **Step 5: Commit verification fixes, if any**

If QA required changes, rerun the relevant focused tests and commit only those fixes:

```bash
rtk git add packages/provider-schemas packages/server packages/dashboard packages/i18n bun.lock
rtk git commit -m "fix(dashboard): address provider schema verification" -m "Co-authored-by: Codex <noreply@openai.com>"
```

If no files changed, do not create an empty commit.

---

## Completion Criteria

- The new provider-schemas package generates every versionless allowlist entry from public npm latest without installing provider dependencies; output records the resolved version and may change when latest moves.
- Its runtime export contains no Babel, TypeBox, provider package, or filesystem dependency.
- Server package status distinguishes bundled/installed/missing from schema availability.
- `@ai-sdk/**` trusted missing packages install automatically only on blur/Enter.
- Untrusted missing packages require explicit confirmation.
- CodeEditor focus and invalid styles match Input.
- JsonEditor supports arbitrary JSON roots, Monaco schemas, multiple mounted instances, raw invalid drafts, and warning/error distinction.
- Provider options require an object and block Save on syntax/root/schema errors.
- Packages without embedded schemas remain configurable.
- JSDoc hover works for generated schemas.
- Focused tests, builds, repository check, preflight, and browser QA all pass.
