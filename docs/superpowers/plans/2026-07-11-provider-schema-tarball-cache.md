# Provider Schema Tarball Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate schemas for the expanded public provider allowlist from npm `latest` tarballs without declaring provider packages as `@aio-proxy/provider-schemas` dependencies.

**Architecture:** A build-only `resolveProviderSource()` module owns npm metadata, integrity verification, safe declaration-only extraction, and a versioned local cache. The existing schema generator receives an absolute cached package root. The Rsbuild plugin uses `onBeforeBuild.isWatch` only to select refresh policy; `api.transform` remains the sole schema-generation entry.

**Tech Stack:** TypeScript, Rslib/Rsbuild plugin hooks, Node `fetch`/`crypto`/`fs`, `tar`, Bun tests.

## Global Constraints

- The schema allowlist remains `{ packageName, factoryName }` and contains no version field.
- One-shot `rslib build` checks npm `dist-tags.latest` every time.
- `rslib --watch` uses its cached `latest.json` pointer and accesses npm only when no usable cache exists.
- Provider packages are not dependencies of `@aio-proxy/provider-schemas` and are not installed into workspace `node_modules` for schema generation.
- Only package-owned `package.json` and `.d.ts`/`.d.mts`/`.d.cts` files are extracted.
- Tarballs are limited to 32 MiB compressed, verified against npm `dist.integrity`, and rejected on unsafe paths, links, or package metadata mismatch.
- `api.onBeforeBuild` selects refresh policy only. Schema generation and returned module source occur only inside `api.transform`.
- No explicit `generate` command, committed generated schema artifact, runtime schema parser, private registry support, or fallback to stale cache in one-shot build.
- Babel, TypeBox, tar, registry, generator, and plugin modules must not enter `packages/provider-schemas/dist` or the CLI binary.
- Preserve the user's expanded `packages/provider-schemas/src/allowlist.ts` entries; do not add versions or silently drop failing packages.
- Do not touch or stage `output/`. Do not pop or drop the existing safety stash.

---

### Task 1: Build the npm declaration tarball cache module

**Files:**
- Create: `packages/provider-schemas/scripts/provider-source-cache.ts`
- Create: `packages/provider-schemas/_test/provider-source-cache.test.ts`
- Modify: `packages/provider-schemas/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: `{ packageName, factoryName }` allowlist entries and public npm package metadata.
- Produces:

```ts
export type ProviderSchemaSource = {
  readonly packageName: string;
  readonly factoryName: string;
};

export type ResolveProviderSourceOptions = {
  readonly cacheRoot: string;
  readonly refreshLatest: boolean;
  readonly fetch?: typeof globalThis.fetch;
};

export const resolveProviderSource: (
  source: ProviderSchemaSource,
  options: ResolveProviderSourceOptions,
) => Promise<string>;
```

- [ ] **Step 1: Add failing cache-miss and watch-cache tests**

Create `createRegistryFixture()` in the test file. It returns `{ fetch, requests, close }`, serves package metadata and a tarball created with `tar.create`, and closes its Bun server in `afterEach`. The tarball contains `package/package.json`, `package/dist/index.d.ts`, and `package/dist/index.js`. Add a local `fileExists(path)` helper implemented with `stat(path).then(() => true, () => false)`. Tests assert that only the manifest and declaration are extracted.

```ts
test("downloads npm latest and caches only declarations", async () => {
  const fixture = await createRegistryFixture({ latest: "2.0.0" });
  const root = await resolveProviderSource(
    { packageName: "@fixture/provider", factoryName: "createFixture" },
    { cacheRoot, refreshLatest: true, fetch: fixture.fetch },
  );

  expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toMatchObject({
    name: "@fixture/provider",
    version: "2.0.0",
  });
  expect(await readFile(join(root, "dist/index.d.ts"), "utf8")).toContain("createFixture");
  expect(await fileExists(join(root, "dist/index.js"))).toBe(false);
  expect(fixture.requests).toEqual(["metadata", "tarball"]);
});

test("watch mode reuses the cached latest pointer without registry access", async () => {
  const root = await resolveProviderSource(source, {
    cacheRoot,
    refreshLatest: false,
    fetch: () => Promise.reject(new Error("registry must not be called")),
  });
  expect(root).toEndWith("2.0.0/package");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
rtk bun test packages/provider-schemas/_test/provider-source-cache.test.ts
```

Expected: FAIL because `provider-source-cache.ts` and the `tar` dependency do not exist.

- [ ] **Step 3: Add the one build-only archive dependency**

Run:

```bash
rtk bun add --dev --filter @aio-proxy/provider-schemas tar
```

Expected: `tar` is added only to `@aio-proxy/provider-schemas` devDependencies and `bun.lock` changes; no provider package is added.

- [ ] **Step 4: Implement metadata resolution, integrity verification, and declaration-only extraction**

Implement these internal types and helpers in `provider-source-cache.ts`:

```ts
type NpmVersionMetadata = {
  readonly name: string;
  readonly version: string;
  readonly dist: { readonly tarball: string; readonly integrity: string };
};

type NpmPackageMetadata = {
  readonly "dist-tags": { readonly latest: string };
  readonly versions: Readonly<Record<string, NpmVersionMetadata>>;
};

const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
const declarationPath = /(?:^|\/)package\/(?:package\.json|.*\.d\.[cm]?ts)$/;
```

Use `encodeURIComponent(packageName)` for the registry metadata URL. Parse SRI as `<algorithm>-<base64>`, hash the downloaded bytes with `node:crypto`, and compare decoded bytes with `timingSafeEqual`. Reject missing/invalid metadata and non-2xx responses with errors containing `packageName`.

Load `tar` through the existing build-only bridge rather than a static runtime import so Rslib module execution does not externalize it incorrectly:

```ts
import { providerSchemasRequire } from "./provider-schemas-require";
import type * as Tar from "tar";

const tar = providerSchemasRequire("tar") as typeof Tar;
```

Write the tarball to a temporary sibling directory and call `tar.x` with `strict: true`, `preservePaths: false`, `strip: 1`, and a filter that permits only the package manifest and declaration files and rejects symbolic/hard links. Validate extracted manifest name/version. Atomically rename the version directory, then atomically replace `latest.json` with:

```json
{ "version": "2.0.0" }
```

Always clean temporary paths in `finally`. Treat `EEXIST`/`ENOTEMPTY` on final rename as a successful concurrent winner only after validating the destination manifest.

- [ ] **Step 5: Add failure tests**

Cover:

```ts
test.each([
  "missing latest dist-tag",
  "metadata HTTP failure",
  "tarball HTTP failure",
  "tarball larger than 32 MiB",
  "integrity mismatch",
  "archive traversal path",
  "archive symbolic link",
  "package name mismatch",
  "package version mismatch",
])("rejects %s", async (scenario) => {
  await expect(runScenario(scenario)).rejects.toThrow("@fixture/provider");
});
```

Also assert that `refreshLatest: true` performs a metadata request on each call but does not redownload when `latest` remains unchanged, and downloads a second version when `latest` changes.

- [ ] **Step 6: Run Task 1 verification**

Run:

```bash
rtk bun test packages/provider-schemas/_test/provider-source-cache.test.ts
rtk bunx biome check packages/provider-schemas/scripts/provider-source-cache.ts packages/provider-schemas/_test/provider-source-cache.test.ts packages/provider-schemas/package.json
```

Expected: all cache tests pass; Biome reports no errors.

- [ ] **Step 7: Commit Task 1**

Run:

```bash
rtk git add packages/provider-schemas/scripts/provider-source-cache.ts packages/provider-schemas/_test/provider-source-cache.test.ts packages/provider-schemas/package.json bun.lock
rtk git commit -m "feat(provider-schemas): cache npm declaration sources" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Route Rslib schema generation through the cache

**Files:**
- Modify: `packages/provider-schemas/scripts/provider-schemas-generator.ts`
- Modify: `packages/provider-schemas/scripts/provider-schemas-build.ts`
- Modify: `packages/provider-schemas/scripts/provider-schemas-plugin.ts`
- Modify: `packages/provider-schemas/_test/schema-generator.test.ts`

**Interfaces:**
- Consumes: `resolveProviderSource(source, { cacheRoot, refreshLatest })` from Task 1.
- Produces:

```ts
import type { ProviderSchemaSource } from "./provider-source-cache";

export type GenerateProviderSchemasOptions = {
  readonly cacheRoot: string;
  readonly refreshLatest: boolean;
  readonly sources?: readonly ProviderSchemaSource[];
  readonly resolveSource?: typeof resolveProviderSource;
};

export const generateProviderSchemaEntries: (
  options: GenerateProviderSchemasOptions,
  onDependency?: (dependency: string) => void,
) => Promise<GeneratedProviderSchemas>;
```

- [ ] **Step 1: Write failing plugin mode tests**

Extend the plugin harness to capture `onBeforeBuild` and the arguments passed through the imported generator:

```ts
expect(beforeBuild).toBeDefined();
await beforeBuild?.({ isWatch: true, isFirstCompile: true });
await transformHandler(transformContext);
expect(generateCalls.at(-1)?.options).toEqual({
  cacheRoot: join(rootPath, "node_modules/.cache/provider-schemas"),
  refreshLatest: false,
});

await beforeBuild?.({ isWatch: false, isFirstCompile: true });
await transformHandler(transformContext);
expect(generateCalls.at(-1)?.options.refreshLatest).toBe(true);
```

Assert that `onBeforeBuild` itself does not call the generator, write files, or return generated source.

- [ ] **Step 2: Run the focused plugin test and verify RED**

Run:

```bash
rtk bun test packages/provider-schemas/_test/schema-generator.test.ts -t "selects latest refresh policy from Rslib watch mode"
```

Expected: FAIL because the plugin does not register `onBeforeBuild` or pass cache options.

- [ ] **Step 3: Replace package resolution with source resolution**

In `provider-schemas-generator.ts`, remove `ResolveProviderPackage` and `findProviderPackageRoot`. Default `sources` to `PROVIDER_SCHEMA_ALLOWLIST` and `resolveSource` to `resolveProviderSource`. For every selected source:

```ts
const packageRoot = await resolveSource(allowlisted, options);
const generated = await generateProviderSchemaEntry(packageRoot, allowlisted, addDependency);
```

Keep `generateProviderSchemaEntry`, dependency deduplication, rendering, and normalization unchanged. Export `GenerateProviderSchemasOptions`.

Update `provider-schemas-build.ts` to forward options directly; it must no longer resolve provider packages through `providerSchemasRequire.resolve`.

- [ ] **Step 4: Use `onBeforeBuild.isWatch` only as transform policy**

In `provider-schemas-plugin.ts`:

```ts
let refreshLatest = true;
api.onBeforeBuild(({ isWatch }) => {
  refreshLatest = !isWatch;
});

api.transform({ test: schemaModulePath, order: "pre" }, async ({ addDependency, importModule }) => {
  const generator = await importModule<typeof ProviderSchemasGenerator>(generatorPath);
  const generated = await generator.generateProviderSchemaEntries(
    {
      cacheRoot: join(api.context.rootPath, "node_modules/.cache/provider-schemas"),
      refreshLatest,
    },
    addDependency,
  );
  return generator.renderGeneratedProviderSchemas(generated.entries);
});
```

Do not move generation into `onBeforeBuild` and do not write `src`.

- [ ] **Step 5: Update generator tests to use fixture cache/network inputs**

Tests for generator behavior must not depend on provider packages being installed. Pass a one-entry fixture `sources` array and a fixture `resolveSource` function that returns the temporary package root. Preserve existing assertions for deterministic rendering, JSDoc, aliases, failure-path dependencies, plugin `importModule`, and dist-only output. The real expanded allowlist remains an integration test for Task 3.

- [ ] **Step 6: Run Task 2 verification**

Run:

```bash
rtk bun test packages/provider-schemas/_test/provider-source-cache.test.ts packages/provider-schemas/_test/declaration-parser.test.ts packages/provider-schemas/_test/schema-generator.test.ts
rtk bunx biome check packages/provider-schemas/scripts packages/provider-schemas/_test
```

Expected: all provider-schema tests pass and plugin tests prove generation remains transform-only.

- [ ] **Step 7: Commit Task 2**

Run:

```bash
rtk git add packages/provider-schemas/scripts/provider-schemas-generator.ts packages/provider-schemas/scripts/provider-schemas-build.ts packages/provider-schemas/scripts/provider-schemas-plugin.ts packages/provider-schemas/_test/schema-generator.test.ts
rtk git commit -m "refactor(provider-schemas): resolve cached npm sources" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Remove provider install dependencies and validate the expanded catalog

**Files:**
- Modify: `packages/provider-schemas/src/allowlist.ts`
- Modify: `packages/provider-schemas/package.json`
- Modify: `bun.lock`
- Modify: `packages/provider-schemas/_test/schema-generator.test.ts`
- Modify: `docs/superpowers/specs/2026-07-11-dashboard-json-editor-provider-schema-design.md`
- Modify: `docs/superpowers/plans/2026-07-11-dashboard-json-editor-provider-schema.md`

**Interfaces:**
- Consumes: the user's expanded `{ packageName, factoryName }` catalog and Task 2's cache-backed generator.
- Produces: a dist-only `PROVIDER_OPTIONS_SCHEMAS` catalog generated from npm latest without provider devDependencies.

- [ ] **Step 1: Write the dependency-boundary and expanded-catalog assertions**

Add tests that read `packages/provider-schemas/package.json` and assert none of the allowlisted package names appears in its dependencies or devDependencies. Assert the generated keys exactly match the expanded allowlist and each generated entry reports the same package name and a non-empty `packageVersion`.

```ts
for (const { packageName } of PROVIDER_SCHEMA_ALLOWLIST) {
  expect(packageJson.dependencies?.[packageName]).toBeUndefined();
  expect(packageJson.devDependencies?.[packageName]).toBeUndefined();
  expect(generated.entries[packageName]).toMatchObject({
    packageName,
    packageVersion: expect.any(String),
  });
}
```

Do not weaken generation by skipping missing packages or converting failures into empty entries.

- [ ] **Step 2: Run the expanded-catalog test and verify RED**

Run:

```bash
rtk bun test packages/provider-schemas/_test/schema-generator.test.ts -t "generates the exact allowlist"
```

Expected: FAIL because the current expanded entries are not available through the old installed-package resolver and old provider devDependencies remain.

- [ ] **Step 3: Preserve the user's allowlist and remove provider-only devDependencies**

Keep every current allowlist entry and its factory name without adding versions. Remove these provider packages from `@aio-proxy/provider-schemas` devDependencies:

```text
@ai-sdk/openai
@ai-sdk/anthropic
@ai-sdk/google
@ai-sdk/openai-compatible
@ai-sdk/mistral
@ai-sdk/groq
@ai-sdk/xai
@openrouter/ai-sdk-provider
```

Keep build dependencies and `tar`. Run:

```bash
rtk bun install
```

If npm latest lacks a listed package or factory export, stop and report the exact package/factory mismatch; do not silently remove it.

- [ ] **Step 4: Build from an empty provider source cache**

Create a detached temporary worktree from the Task 2 HEAD, export the tracked Task 3 diff to a temporary patch, apply it there, install with the updated frozen lockfile, and build from its naturally empty provider source cache:

```bash
rtk git worktree add --detach /tmp/aio-proxy-provider-cache-verify HEAD
rtk git diff --binary HEAD -- packages/provider-schemas/src/allowlist.ts packages/provider-schemas/package.json packages/provider-schemas/_test/schema-generator.test.ts docs/superpowers/specs/2026-07-11-dashboard-json-editor-provider-schema-design.md docs/superpowers/plans/2026-07-11-dashboard-json-editor-provider-schema.md bun.lock --output=/tmp/aio-proxy-provider-cache.patch
rtk git -C /tmp/aio-proxy-provider-cache-verify apply /tmp/aio-proxy-provider-cache.patch
rtk bun --cwd /tmp/aio-proxy-provider-cache-verify install --frozen-lockfile
rtk bun --cwd /tmp/aio-proxy-provider-cache-verify run --filter @aio-proxy/provider-schemas build
```

Expected: each allowlisted package resolves from npm latest; `dist/schema-module.js` contains all allowlist package keys. No provider package is added to provider-schemas dependencies.

- [ ] **Step 5: Verify watch cache semantics**

Run a focused watch smoke using a pre-populated cache and a test registry URL that fails on access. Start `rslib --watch --no-clean`, wait for the first successful build, modify a generator fixture, observe a second successful build, then terminate it.

Expected: both watch builds succeed from cache and the fixture change triggers regeneration without registry requests.

- [ ] **Step 6: Update active design and plan docs**

Replace statements that every schema package is a provider-schemas devDependency with the approved tarball-cache behavior. Document that one-shot builds follow npm latest, watch uses cached latest, and output is intentionally not reproducible across latest changes. Do not change runtime trust (`@ai-sdk/**`) or install behavior.

- [ ] **Step 7: Run final verification**

Run:

```bash
rtk bun test packages/provider-schemas/_test/*.test.ts
rtk bun test packages/server/_test/dashboard-provider-options-schema.test.ts packages/server/_test/config-store.test.ts
rtk bun run --filter @aio-proxy/provider-schemas build
rtk bun build packages/cli/src/main.ts --target=bun --outfile=/tmp/aio-proxy-provider-source-cache.js
rtk rg -n '@babel/parser|typebox|\btar\b|provider-source-cache|provider-schemas-generator|provider-schemas-build|provider-schemas-plugin' packages/provider-schemas/dist /tmp/aio-proxy-provider-source-cache.js
rtk bun run preflight
```

Expected:

- provider/server tests pass;
- provider build generates the expanded catalog;
- leakage scan returns no matches;
- preflight completes all Turbo tasks, with only the pre-existing dashboard non-null assertion warning if it still exists.

After verification, remove the temporary worktree from the main repository root:

```bash
rtk git worktree remove /tmp/aio-proxy-provider-cache-verify
rtk git worktree prune
```

- [ ] **Step 8: Commit Task 3**

Run:

```bash
rtk git add packages/provider-schemas/src/allowlist.ts packages/provider-schemas/package.json packages/provider-schemas/_test/schema-generator.test.ts docs/superpowers/specs/2026-07-11-dashboard-json-editor-provider-schema-design.md docs/superpowers/plans/2026-07-11-dashboard-json-editor-provider-schema.md bun.lock
rtk git commit -m "feat(provider-schemas): generate expanded catalog from npm" -m "Co-authored-by: Codex <noreply@openai.com>"
```
