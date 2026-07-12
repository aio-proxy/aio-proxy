# Provider Schemas Bun Archive Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the build-only `tar` package and `providerSchemasRequire` workaround with Bun 1.3.14+ `Bun.Archive` and standard ESM imports without changing schema generation, cache publication, or runtime artifacts.

**Architecture:** The npm tarball remains downloaded and integrity-verified as a bounded byte array. `Bun.Archive.files()` enumerates archive files; application code validates all returned paths, selected file count, and selected byte total before writing allowed manifest/declaration blobs into the existing temporary cache root. Rslib continues to load the generator only through `api.transform().importModule()`, while build dependencies use ordinary ESM resolution.

**Tech Stack:** Bun 1.3.14+, TypeScript, Bun.Archive, Rslib/Rsbuild plugin API, Bun test.

## Global Constraints

- `@aio-proxy/provider-schemas` build requires Bun 1.3.14 or newer; Node build compatibility is not required.
- Rslib `api.transform` and its `importModule()` callback remain the sole schema-generation path.
- No explicit generate command, committed generated schema source, runtime schema parser, or test-specific generation path may be added.
- Every one-shot provider-schema build continues to resolve npm `latest`; watch continues to use valid cached observations and fetch only on a cold/unusable cache.
- Tarball downloads remain capped at 32 MiB and verified against npm `dist.integrity` before archive parsing.
- Only `package/package.json`, `.d.ts`, `.d.mts`, and `.d.cts` file entries may be written.
- At most 65 selected files and `4 * 1024 * 1024 + 64 * 1024` selected bytes may be written.
- Unsafe archive file paths fail the build. Directory, symbolic-link, and hard-link entries are omitted by Bun and must never be materialized.
- Completion manifests, atomic cache publication, immutable observations, corrupt-cache behavior, and cleanup semantics remain unchanged.
- `tar`, `provider-schemas-require`, Babel, TypeBox, and schema build modules must not enter provider dist or the CLI binary.
- Preserve the untracked `output/` directory and `stash@{0}`.

---

### Task 1: Replace tar extraction with Bun.Archive

**Files:**
- Modify: `packages/provider-schemas/_test/provider-source-cache.test.ts`
- Modify: `packages/provider-schemas/scripts/provider-source-cache.ts`
- Modify: `packages/provider-schemas/package.json`

**Interfaces:**
- Consumes: `downloadTarball(packageName, metadata, fetchImpl): Promise<Uint8Array>` and the existing temporary cache-root publication flow.
- Produces: the unchanged `resolveProviderSource(source, options): Promise<string>` API, backed by Bun Archive file enumeration instead of `tar.x()`.

- [ ] **Step 1: Convert registry tarball fixtures to Bun.Archive and write the new behavior assertions**

Remove `import * as tar from "tar"`. Build normal fixture archives with Bun:

```ts
const archiveBytes = async (
  files: Readonly<Record<string, string | Uint8Array>>,
  mutate?: (archive: Uint8Array) => Uint8Array,
) => {
  const raw = new Uint8Array(await new Bun.Archive(files).bytes());
  return Bun.gzipSync(mutate ? mutate(raw) : raw);
};
```

Retain the existing tar-header checksum helpers for malicious fixtures. Create traversal and absolute-path fixtures by using those paths as Bun Archive keys. Create symbolic-link and hard-link fixtures by changing the selected header type flag to `"2"` and `"1"`, setting the link target, and recomputing the checksum. Create the declaration-shaped directory fixture with a key ending in `/`, then remove the trailing slash from its header and recompute its checksum.

Change the link tests from rejection to successful resolution plus absence assertions:

```ts
test.each([
  ["archive symbolic link", "dist/link.d.ts"],
  ["archive hard link", "dist/hard.d.ts"],
] as const)("omits %s entries from the cache", async (scenario, relativePath) => {
  const fixture = await createRegistryFixture({ latest: "2.0.0", scenario });
  const root = await resolveProviderSource(source, {
    cacheRoot: createCacheRoot(),
    refreshLatest: true,
    fetch: fixture.fetch,
  });
  expect(await fileExists(join(root, relativePath))).toBe(false);
});
```

Remove the corrupt-trailing-header mechanism from the file-count and extracted-byte fixtures because Bun Archive exposes no per-entry abort hook. Keep their package-specific limit assertions and cleanup assertions.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
rtk bun test packages/provider-schemas/_test/provider-source-cache.test.ts -t "omits archive symbolic link entries|omits archive hard link entries"
```

Expected: FAIL because the current `tar.x()` filter rejects archive links instead of resolving the package while omitting them.

- [ ] **Step 3: Implement validated Bun Archive materialization**

Remove the `Tar` type import and `providerSchemasRequire("tar")`. Import `dirname` with the other path helpers.

Anchor the selection pattern at the npm archive root:

```ts
const declarationPath = /^package\/(?:package\.json|.*\.d\.[cm]?ts)$/;
```

Add a focused helper above `installVersion`:

```ts
type SelectedArchiveFile = {
  readonly path: string;
  readonly file: File;
};

const selectArchiveFiles = async (packageName: string, bytes: Uint8Array): Promise<SelectedArchiveFile[]> => {
  const files = await new Bun.Archive(bytes).files();
  const selected: SelectedArchiveFile[] = [];
  let selectedBytes = 0;

  for (const [path, file] of files) {
    if (unsafeArchivePath(path)) throw new Error(`Archive unsafe path is not allowed for ${packageName}`);
    if (!declarationPath.test(path)) continue;
    selected.push({ path, file });
    if (selected.length > MAX_EXTRACTED_FILES) {
      throw new Error(`Extracted file count limit exceeded for ${packageName}`);
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`Archive entry size is not allowed for ${packageName}`);
    }
    selectedBytes += file.size;
    if (selectedBytes > MAX_EXTRACTED_BYTES) {
      throw new Error(`Extracted declaration size limit exceeded for ${packageName}`);
    }
  }
  return selected;
};
```

Replace `tar.x()` with validation followed by manual writes:

```ts
const extractedPackageRoot = join(temporaryRoot, "package");
for (const { path, file } of await selectArchiveFiles(packageName, await readFile(archivePath))) {
  const relativePath = path.slice("package/".length);
  const destination = join(extractedPackageRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, new Uint8Array(await file.arrayBuffer()));
}
```

Keep archive removal, manifest validation, completion hashing, publication, concurrency handling, and the outer `finally` unchanged. Remove `"tar"` from `packages/provider-schemas/package.json`.

- [ ] **Step 4: Run focused and full source-cache tests and verify GREEN**

Run:

```bash
rtk bun test packages/provider-schemas/_test/provider-source-cache.test.ts
```

Expected: all source-cache tests pass, including traversal rejection, omitted links/directories, 65-file limit, byte limit, cleanup, cache validation, observation concurrency, and integrity checks.

- [ ] **Step 5: Commit Task 1**

```bash
rtk git add packages/provider-schemas/_test/provider-source-cache.test.ts packages/provider-schemas/scripts/provider-source-cache.ts packages/provider-schemas/package.json
rtk git commit -m "refactor(provider-schemas): use Bun archive reader" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Delete providerSchemasRequire and restore standard ESM imports

**Files:**
- Modify: `packages/provider-schemas/_test/schema-generator.test.ts`
- Modify: `packages/provider-schemas/scripts/declaration-entry.ts`
- Modify: `packages/provider-schemas/scripts/declaration-parser.ts`
- Modify: `packages/provider-schemas/scripts/provider-schemas-generator.ts`
- Modify: `packages/provider-schemas/scripts/provider-source-cache.ts`
- Delete: `packages/provider-schemas/scripts/provider-schemas-require.ts`

**Interfaces:**
- Consumes: the existing build-only module graph loaded by `provider-schemas-plugin.ts` through `importModule()`.
- Produces: identical generator/parser/source-cache exports with ordinary ESM dependency loading.

- [ ] **Step 1: Add an architecture regression for standard imports**

In `schema-generator.test.ts`, add:

```ts
test("uses standard ESM imports for provider schema build dependencies", async () => {
  const scriptsRoot = join(import.meta.dir, "../scripts");
  expect(existsSync(join(scriptsRoot, "provider-schemas-require.ts"))).toBe(false);
  for (const name of [
    "declaration-entry.ts",
    "declaration-parser.ts",
    "provider-schemas-generator.ts",
    "provider-source-cache.ts",
  ]) {
    expect(await readFile(join(scriptsRoot, name), "utf8")).not.toContain("providerSchemasRequire");
  }
});
```

Add `existsSync` to the existing `node:fs` test import; do not add a production-only probe.

- [ ] **Step 2: Run the architecture test and verify RED**

Run:

```bash
rtk bun test packages/provider-schemas/_test/schema-generator.test.ts -t "uses standard ESM imports"
```

Expected: FAIL because `provider-schemas-require.ts` exists and its consumers contain `providerSchemasRequire`.

- [ ] **Step 3: Replace every custom require with static ESM imports**

Use these imports:

```ts
// declaration-entry.ts
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// declaration-parser.ts
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "@babel/parser";

// provider-schemas-generator.ts
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { Script } from "typebox";

// provider-source-cache.ts
import { createHash, timingSafeEqual } from "node:crypto";
import type { Dirent } from "node:fs";
import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
```

Delete `provider-schemas-require.ts`. Do not introduce dynamic imports, `createRequire`, dependency injection, or a replacement loader abstraction.

- [ ] **Step 4: Verify the architecture and real Rslib transform**

Run:

```bash
rtk bun test packages/provider-schemas/_test/schema-generator.test.ts -t "uses standard ESM imports|loads the production provider schema build graph through a real Rslib transform"
rtk bun run --filter @aio-proxy/provider-schemas test:unit
```

Expected: both focused tests pass and the complete provider unit suite passes.

- [ ] **Step 5: Commit Task 2**

```bash
rtk git add packages/provider-schemas/_test/schema-generator.test.ts packages/provider-schemas/scripts/declaration-entry.ts packages/provider-schemas/scripts/declaration-parser.ts packages/provider-schemas/scripts/provider-schemas-generator.ts packages/provider-schemas/scripts/provider-source-cache.ts packages/provider-schemas/scripts/provider-schemas-require.ts
rtk git commit -m "refactor(provider-schemas): use standard ESM imports" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Update dependency-boundary documentation and verify production artifacts

**Files:**
- Modify: `packages/provider-schemas/_test/runtime-leakage-smoke.ts`
- Modify: `docs/superpowers/specs/2026-07-11-provider-schema-tarball-cache-design.md`
- Modify: `docs/superpowers/plans/2026-07-11-provider-schema-tarball-cache.md`
- Modify: `docs/superpowers/specs/2026-07-12-provider-schemas-bun-archive-design.md` only if implementation evidence requires a factual correction.

**Interfaces:**
- Consumes: completed Bun Archive and ESM migration from Tasks 1 and 2.
- Produces: documentation and artifact checks that describe and enforce the final build boundary.

- [ ] **Step 1: Strengthen the leakage assertion**

Extend the build-only pattern:

```ts
const BUILD_ONLY_PATTERN =
  /@babel\/parser|typebox|\btar\b|provider-schemas-require|provider-source-cache|provider-schemas-generator|provider-schemas-build|provider-schemas-plugin/iu;
```

Keep scanning actual provider dist and the CLI bundle; do not replace the smoke test with source-string-only checks.

- [ ] **Step 2: Update the prior cache design and plan**

Replace statements that the build uses the npm `tar` package with the approved Bun 1.3.14+ behavior:

- `Bun.Archive.files()` enumerates files after integrity verification.
- Application code validates all returned paths, selected count, and selected bytes before writing.
- Directories and links are omitted by Bun and never materialized.
- File/byte limits are evaluated after archive enumeration because Bun exposes no per-entry abort callback.
- Standard ESM imports replace `providerSchemasRequire`.

Remove commands or dependency expectations that require `tar`, while retaining leakage scans for the string/module.

- [ ] **Step 3: Run integration, production leakage, and repository verification**

Run:

```bash
rtk bun run --filter @aio-proxy/provider-schemas test:integration
rtk bun run preflight
rtk git diff --check
rtk rg -n '"tar"|providerSchemasRequire|provider-schemas-require' packages/provider-schemas/package.json packages/provider-schemas/scripts
```

Expected:

- live 42-package npm-latest catalog passes;
- clean-dist source start passes;
- actual provider dist and CLI leakage scan passes;
- preflight reports 13 successful Turbo tasks, with only the pre-existing dashboard non-null assertion warning if still present;
- diff check is clean;
- the final `rg` command returns no matches.

- [ ] **Step 4: Commit Task 3**

```bash
rtk git add packages/provider-schemas/_test/runtime-leakage-smoke.ts docs/superpowers/specs/2026-07-11-provider-schema-tarball-cache-design.md docs/superpowers/plans/2026-07-11-provider-schema-tarball-cache.md docs/superpowers/specs/2026-07-12-provider-schemas-bun-archive-design.md
rtk git commit -m "docs(provider-schemas): document Bun archive boundary" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Final review and PR publication

**Files:**
- No planned source changes; fix only reviewer-confirmed defects.

**Interfaces:**
- Consumes: all committed migration tasks and their verification evidence.
- Produces: a reviewed, pushed update to PR #19.

- [ ] **Step 1: Generate a whole-branch review package**

Run:

```bash
rtk /Users/baran/.codex/plugins/cache/openai-curated-remote/superpowers/6.1.1/skills/subagent-driven-development/scripts/review-package 5868d20fb24f8554f9c1e44256dfebecf915d0de HEAD
```

Expected: a `.superpowers/sdd/review-*.diff` path covering the complete PR branch.

- [ ] **Step 2: Dispatch final review and resolve every Critical or Important finding**

The reviewer must explicitly check Bun Archive security semantics, module resolution under real Rslib `importModule()`, absence of `tar` and `providerSchemasRequire`, cache compatibility, runtime leakage, and the single generation path. Re-run covering tests after every fix wave.

- [ ] **Step 3: Push and monitor PR checks**

Run:

```bash
rtk git push origin codex/dashboard-json-editor-provider-schema
rtk gh pr checks 19 --repo aio-proxy/aio-proxy --watch --interval 10
rtk gh pr view 19 --repo aio-proxy/aio-proxy --json mergeable,mergeStateStatus,statusCheckRollup,url
```

Expected: branch and origin point to the same HEAD, CI succeeds, and PR #19 reports `MERGEABLE` with a clean merge state.
