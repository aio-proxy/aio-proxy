# Provider Schemas Rsbuild Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provider schema generation a module-aware Rsbuild plugin that tracks declaration inputs and never writes the working tree during a normal build.

**Architecture:** The declaration parser and generator return the exact files consumed while producing schemas. An exported Rsbuild plugin uses `api.transform` for `src/generated.ts`, registers those inputs through `addDependency`, checks the committed artifact for freshness, and returns the generated module source to Rspack. Updating the committed artifact becomes an explicit package command.

**Tech Stack:** Bun 1.3.14, TypeScript 6, Rslib 0.23, Rsbuild/Rspack plugin API, Babel TypeScript AST, TypeBox Script.

## Global Constraints

- `src/generated.ts` remains committed and deterministic.
- Normal `rslib` builds must not write tracked source files.
- The plugin name is exactly `aio-proxy:provider-schemas`.
- The plugin uses `api.transform` and registers every consumed provider `package.json` and `.d.ts` through `addDependency`.
- Stale committed output fails with an actionable `bun run --filter @aio-proxy/provider-schemas generate` message.
- `@babel/parser`, TypeBox, provider declarations, and generator code remain outside the standalone runtime graph.
- The eight-package allowlist, schema format, server APIs, dashboard behavior, and `route-tree.gen.ts` do not change.
- Use `rtk` for shell commands.
- Every commit ends with `Co-authored-by: Codex <noreply@openai.com>`.

---

## File Map

- `packages/provider-schemas/scripts/declaration-parser.ts` — expose declaration files traversed by parsing.
- `packages/provider-schemas/scripts/generate-provider-schemas.ts` — return schema entries plus generator dependencies; retain explicit file writer and CLI entrypoint.
- `packages/provider-schemas/scripts/provider-schemas-plugin.ts` — exported module-aware Rsbuild plugin.
- `packages/provider-schemas/rslib.config.ts` — register the exported plugin only.
- `packages/provider-schemas/package.json` — add explicit `generate` command.
- `packages/provider-schemas/_test/declaration-parser.test.ts` — verify traversed declaration paths.
- `packages/provider-schemas/_test/schema-generator.test.ts` — verify dependency aggregation, transform registration, dependency tracking, and stale failure.

---

### Task 1: Expose exact generator dependencies

**Files:**
- Modify: `packages/provider-schemas/scripts/declaration-parser.ts`
- Modify: `packages/provider-schemas/scripts/generate-provider-schemas.ts`
- Modify: `packages/provider-schemas/_test/declaration-parser.test.ts`
- Modify: `packages/provider-schemas/_test/schema-generator.test.ts`

**Interfaces:**
- Produces: `ParsedProviderFactoryDeclaration.sourceFiles`, `GeneratedProviderSchemaEntry`, and `GeneratedProviderSchemas`.
- Consumes: existing bounded declaration traversal and deterministic renderer.

- [ ] **Step 1: Write failing parser dependency assertions**

Extend the existing relative re-export test so it retains the created entry/shared paths and asserts exact sorted files:

```ts
expect(parsed.sourceFiles).toEqual([entry, shared].sort());
```

Also assert the single-file factory fixture returns `[entry]`.

- [ ] **Step 2: Run the parser test and verify RED**

Run:

```bash
rtk bun test packages/provider-schemas/_test/declaration-parser.test.ts
```

Expected: FAIL because `sourceFiles` is undefined.

- [ ] **Step 3: Return traversed declaration paths**

Add the field:

```ts
export type ParsedProviderFactoryDeclaration = {
  readonly parameterType: string;
  readonly optional: boolean;
  readonly declarations: readonly string[];
  readonly documentation: Readonly<Record<string, string>>;
  readonly sourceFiles: readonly string[];
};
```

Return it using the parser's existing state:

```ts
sourceFiles: [...state.files.keys()].sort(compareCodeUnits),
```

Define a local code-unit comparator rather than `localeCompare`.

- [ ] **Step 4: Write failing generator dependency assertions**

Change generator tests to expect structured results:

```ts
const generated = await generateProviderSchemaEntries();
expect(Object.keys(generated.entries)).toEqual(
  PROVIDER_SCHEMA_ALLOWLIST.map(({ packageName }) => packageName),
);
expect(generated.dependencies).toContainEqual(
  expect.stringMatching(/@ai-sdk\/openai-compatible\/package\.json$/),
);
expect(generated.dependencies).toContainEqual(expect.stringMatching(/\.d\.ts$/));
```

Update existing schema assertions to read `generated.entries`.

- [ ] **Step 5: Run the generator test and verify RED**

Run:

```bash
rtk bun test packages/provider-schemas/_test/schema-generator.test.ts
```

Expected: FAIL because generation still returns only the entry record.

- [ ] **Step 6: Return entries and dependencies without duplicate parsing**

Add these exported result types:

```ts
export type GeneratedProviderSchemaEntry = {
  readonly entry: ProviderOptionsSchemaEntry;
  readonly dependencies: readonly string[];
};

export type GeneratedProviderSchemas = {
  readonly entries: Readonly<Record<string, ProviderOptionsSchemaEntry>>;
  readonly dependencies: readonly string[];
};
```

`generateProviderSchemaEntry()` returns the entry plus a code-unit-sorted dependency list containing `join(packageRoot, "package.json")` and `parsed.sourceFiles`. `generateProviderSchemaEntries()` aggregates entries and a deduplicated sorted dependency set. Update the writer and freshness test to render `.entries`.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
rtk bun test packages/provider-schemas/_test/declaration-parser.test.ts packages/provider-schemas/_test/schema-generator.test.ts
```

Expected: all tests pass.

Commit:

```bash
rtk git add packages/provider-schemas/scripts packages/provider-schemas/_test
rtk git commit -m "refactor(provider-schemas): expose generator dependencies" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Replace the build hook with a module transform plugin

**Files:**
- Create: `packages/provider-schemas/scripts/provider-schemas-plugin.ts`
- Modify: `packages/provider-schemas/rslib.config.ts`
- Modify: `packages/provider-schemas/scripts/generate-provider-schemas.ts`
- Modify: `packages/provider-schemas/package.json`
- Modify: `packages/provider-schemas/_test/schema-generator.test.ts`

**Interfaces:**
- Consumes: `generateProviderSchemaEntries()` returning `{ entries, dependencies }` and `renderGeneratedProviderSchemas()`.
- Produces: `pluginProviderSchemas(): RsbuildPlugin` and explicit package command `generate`.

- [ ] **Step 1: Write failing plugin registration and transform tests**

Capture `api.transform` from `pluginProviderSchemas().setup()` with a minimal typed test double. Assert:

```ts
expect(plugin.name).toBe("aio-proxy:provider-schemas");
expect(plugin.apply).toBe("build");
expect(registration.descriptor.test).toBe(generatedProviderSchemasPath);
```

Invoke the captured handler with the current committed source and an `addDependency` collector. Assert the returned source equals the committed source, dependencies include provider manifests and declaration files, and the plugin never registers `onBeforeBuild`.

Invoke it again with `code: "stale"` and assert rejection contains:

```text
bun run --filter @aio-proxy/provider-schemas generate
```

- [ ] **Step 2: Run the plugin test and verify RED**

Run:

```bash
rtk bun test packages/provider-schemas/_test/schema-generator.test.ts
```

Expected: FAIL because `provider-schemas-plugin.ts` does not exist.

- [ ] **Step 3: Implement the module-aware plugin**

Create:

```ts
import { fileURLToPath } from "node:url";
import type { RsbuildPlugin } from "@aio-proxy/infra/rslib";
import { generateProviderSchemaEntries, renderGeneratedProviderSchemas } from "./generate-provider-schemas";

export const generatedProviderSchemasPath = fileURLToPath(new URL("../src/generated.ts", import.meta.url));

export const pluginProviderSchemas = (): RsbuildPlugin => ({
  name: "aio-proxy:provider-schemas",
  apply: "build",
  setup(api) {
    api.transform({ test: generatedProviderSchemasPath, order: "pre" }, async ({ code, addDependency }) => {
      const generated = await generateProviderSchemaEntries();
      for (const dependency of generated.dependencies) addDependency(dependency);
      const source = renderGeneratedProviderSchemas(generated.entries);
      if (code !== source) {
        throw new Error(
          "Provider schemas are stale. Run: bun run --filter @aio-proxy/provider-schemas generate",
        );
      }
      api.logger.info(`provider schemas: ${Object.keys(generated.entries).length} generated`);
      return source;
    });
  },
});
```

- [ ] **Step 4: Register the plugin and add explicit generation**

Replace the inline plugin in `rslib.config.ts`:

```ts
import { defineLibraryConfig } from "@aio-proxy/infra/rslib";
import { pluginProviderSchemas } from "./scripts/provider-schemas-plugin";

export default defineLibraryConfig({ plugins: [pluginProviderSchemas()] });
```

Add to `package.json`:

```json
"generate": "bun scripts/generate-provider-schemas.ts"
```

Add the script entrypoint after the writer definition:

```ts
if (import.meta.main) await writeGeneratedProviderSchemas();
```

- [ ] **Step 5: Run focused plugin tests and build**

Run:

```bash
rtk bun test packages/provider-schemas/_test/*.test.ts
rtk bun run --filter @aio-proxy/provider-schemas generate
rtk bun run --filter @aio-proxy/provider-schemas build
rtk git diff --exit-code packages/provider-schemas/src/generated.ts
```

Expected: tests/build pass and generation leaves the committed artifact unchanged.

- [ ] **Step 6: Verify runtime boundary and repository integration**

Run:

```bash
rtk bun build packages/cli/src/main.ts --target=bun --outfile=/tmp/aio-proxy-rsbuild-plugin-runtime.js
rtk rg -n '@babel/parser|typebox/build/type/script|provider-schemas-plugin|generate-provider-schemas' /tmp/aio-proxy-rsbuild-plugin-runtime.js
rtk bun run preflight
```

Expected: bundle succeeds, `rg` has no matches, and preflight succeeds.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/provider-schemas bun.lock
rtk git commit -m "refactor(provider-schemas): generate through rsbuild transform" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Completion Criteria

- Rslib config registers an exported, scoped Rsbuild plugin.
- The plugin uses `api.transform`; no generation lifecycle hook writes source during build.
- Every consumed provider manifest and declaration file is registered with `addDependency`.
- Build fails on stale committed generated source with the exact regeneration command.
- Explicit generation is deterministic and leaves a current artifact unchanged.
- Provider schema tests, package build, preflight, and runtime leakage scan pass.
