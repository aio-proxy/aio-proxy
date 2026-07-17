# OAuth Plugin Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional OAuth capability icon whose LobeHub keys are exact in the published SDK declaration, while URL/data icons are safely validated and invalid display metadata degrades without failing the plugin.

**Architecture:** `@aio-proxy/plugin-sdk` evaluates its Rslib config to scan `@lobehub/icons-static-svg` and atomically write an exact global-helper declaration below Rsbuild's cache path before Rslib initializes declaration generation. The deterministic declaration is passed as `banner.dts`, so `dts.bundle` emits the exact union without a private type-module import. Core owns runtime classification and sanitization; registry staging logs and strips invalid icons but still commits the capability. No generated source file or standalone codegen command is introduced.

**Tech Stack:** Bun 1.3.14, TypeScript 6, Rslib 0.23.2, Rsbuild 2.1.4, API Extractor 7.58.11, `@lobehub/icons-static-svg` 1.93.0, Bun test.

## Global Constraints

- Dashboard rendering, asset delivery, caching, and fallback behavior are out of scope.
- `PLUGIN_API_VERSION` remains `1`; `OAuthAdapter.icon` is optional.
- `bun run build` and `bun run preflight` are the only authoritative declaration flows; do not add `generate:*`, `postinstall`, or a manually invoked codegen command.
- The exact key module lives below `api.context.cachePath`; no generated key source is committed.
- Source/editor type checking sees a broad global-helper placeholder; config evaluation supplies the exact helper declaration to the final Rslib declaration banner during build.
- `plugin-sdk` alone enables `dts.bundle: true`; the shared Rslib defaults remain bundleless.
- `@microsoft/api-extractor` is root-hoisted because Bun's isolated linker does not expose a package-local optional peer to Rslib's dynamic import; only `plugin-sdk` enables and uses `dts.bundle`.
- The final `dist/index.d.ts` contains the exact union and contains no private specifier, placeholder reference, or cache path.
- Runtime JavaScript contains no complete Lobe key array, `Set`, or existence lookup.
- Lobe slugs match `/^[a-z0-9]+(?:-[a-z0-9]+)*$/u`.
- HTTP and HTTPS icons must be absolute URLs.
- Data icons allow only `image/svg+xml`, `image/png`, `image/webp`, `image/gif`, and `image/avif`, including valid MIME parameters and base64 or percent-encoded payloads.
- The original icon string is limited to 256 KiB before payload decoding.
- Invalid icon values are stripped, logged without the raw icon, and do not prevent staging commit.
- Shell commands use `rtk`.
- Commits append `Co-authored-by: Codex <noreply@openai.com>`.

---

### Task 1: Generate and Bundle the Exact Lobe Icon Key Type During SDK Build

**Files:**
- Create: `packages/plugin-sdk/build/lobe-icon-keys.ts`
- Create: `packages/plugin-sdk/build/lobe-icon-keys.test.ts`
- Create: `packages/plugin-sdk/src/internal/lobe-icon-key-placeholder.d.ts`
- Modify: `packages/plugin-sdk/src/oauth.ts`
- Modify: `packages/plugin-sdk/tsconfig.json`
- Modify: `packages/plugin-sdk/rslib.config.ts`
- Modify: `packages/plugin-sdk/package.json`
- Modify: `package.json`
- Modify: `turbo.json`
- Modify: `bun.lock`
- Create: `packages/plugin-sdk/_test/build-artifact.test.ts`

**Interfaces:**
- Produces: `LobeIconKey`, `OAuthIcon`, `LOBE_ICON_KEY_HELPER`, `resolveLobeIconPackage(fromUrl)`, `iconKeysFromFileNames(fileNames)`, `readLobeIconKeys(iconsDirectory)`, `renderLobeIconKeyDeclaration(keys)`, `lobeIconTypePath(cachePath, version)`, `prepareLobeIconTypeBuild(options)`, and `createLobeIconTypePlugin(options)`.
- Consumes: `defineLibraryConfig()` merge-by-library-id behavior and Rslib's `banner.dts` declaration rollup hook.
- Source helper: `AioProxyLobeIconKey`.

**Implemented lifecycle correction:** The private-specifier, `tsconfig.paths`, and `dts.alias` snippets below are superseded. Rslib 0.23.2 reads the source tsconfig before plugin `setup`, while API Extractor later reloads that original tsconfig and preserves alias imports. The implemented build instead writes `declare type AioProxyLobeIconKey = ...` under the cache during config evaluation and passes the same deterministic content through `banner.dts`; source keeps only a broad global placeholder. This keeps generation inside the single build flow and leaves no type-module specifier in the artifact.

- [ ] **Step 1: Write failing generator and artifact tests**

Create `packages/plugin-sdk/build/lobe-icon-keys.test.ts` with fixtures that establish sorting, filename validation, duplicate rejection, empty input rejection, and deterministic rendering:

```ts
import { describe, expect, test } from "bun:test";
import {
  iconKeysFromFileNames,
  renderLobeIconKeyDeclaration,
} from "./lobe-icon-keys";

describe("Lobe icon key generation", () => {
  test("sorts valid SVG keys and renders a deterministic union", () => {
    const keys = iconKeysFromFileNames(["openai.svg", "anthropic.svg", "codex-color.svg"]);
    expect(keys).toEqual(["anthropic", "codex-color", "openai"]);
    expect(renderLobeIconKeyDeclaration(keys)).toBe(
      'export type LobeIconKey = "anthropic" | "codex-color" | "openai";\n',
    );
  });

  test.each([
    ["empty package", []],
    ["invalid uppercase key", ["OpenAI.svg"]],
    ["invalid separator", ["open_ai.svg"]],
    ["duplicate key", ["openai.svg", "openai.svg"]],
  ])("rejects %s", (_name, files) => {
    expect(() => iconKeysFromFileNames(files)).toThrow();
  });
});
```

Create `packages/plugin-sdk/_test/build-artifact.test.ts`. It must:

1. read `dist/index.d.ts` and `dist/index.js`;
2. assert the declaration contains `export declare type LobeIconKey` plus both `"openai"` and `"githubcopilot"`;
3. assert it does not contain `#aio-proxy/lobe-icon-key`, `lobe-icon-key-placeholder`, `node_modules/.cache`, or the absolute workspace path;
4. assert runtime JavaScript does not contain `"githubcopilot"` or an exported `lobeIconKeys` value;
5. create a temporary TypeScript fixture that accepts `"openai"`, HTTP, HTTPS, and image data URLs and contains an `@ts-expect-error` assignment for `"definitely-not-a-real-lobe-icon-key-zzz"`;
6. run the workspace `tsc` with `moduleResolution: "Bundler"` against that fixture and require exit code `0`.

Use this exact fixture body inside the artifact test:

```ts
const fixtureSource = `
import type { OAuthIcon } from ${JSON.stringify(sdkEntry)};

const lobe: OAuthIcon = "openai";
const http: OAuthIcon = "http://example.com/icon.svg";
const https: OAuthIcon = "https://example.com/icon.svg";
const data: OAuthIcon = "data:image/png;base64,iVBORw0KGgo=";

// @ts-expect-error the built declaration must reject unknown Lobe keys
const invalid: OAuthIcon = "definitely-not-a-real-lobe-icon-key-zzz";

void [lobe, http, https, data, invalid];
`;
```

- [ ] **Step 2: Run the focused tests to verify RED**

Run:

```bash
rtk bun test packages/plugin-sdk/build/lobe-icon-keys.test.ts
rtk bun test packages/plugin-sdk/_test/build-artifact.test.ts
```

Expected: the unit test fails because the build module does not exist; the artifact test fails because the current SDK declaration has no icon types or exact union.

- [ ] **Step 3: Implement the build-owned generator and cache writer**

Create `packages/plugin-sdk/build/lobe-icon-keys.ts` with these exact responsibilities and signatures:

```ts
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { RsbuildPlugin } from "@aio-proxy/infra/rslib";

export const LOBE_ICON_KEY_SPECIFIER = "#aio-proxy/lobe-icon-key";
const LOBE_ICON_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type LobeIconPackage = {
  readonly iconsDirectory: string;
  readonly version: string;
};

export function resolveLobeIconPackage(fromUrl: string): LobeIconPackage {
  const packageJsonPath = createRequire(fromUrl).resolve("@lobehub/icons-static-svg/package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { readonly version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.trim() === "") {
    throw new Error("@lobehub/icons-static-svg has no valid version");
  }
  return {
    iconsDirectory: join(dirname(packageJsonPath), "icons"),
    version: packageJson.version,
  };
}

export function iconKeysFromFileNames(fileNames: readonly string[]): readonly string[] {
  const svgFiles = fileNames.filter((name) => name.endsWith(".svg"));
  if (svgFiles.length === 0) throw new Error("@lobehub/icons-static-svg contains no SVG icons");
  const seen = new Set<string>();
  const keys = svgFiles.map((name) => {
    const key = name.slice(0, -4);
    if (!LOBE_ICON_SLUG.test(key)) throw new Error(`Invalid Lobe icon filename: ${name}`);
    if (seen.has(key)) throw new Error(`Duplicate Lobe icon key: ${key}`);
    seen.add(key);
    return key;
  });
  return keys.toSorted();
}

export function readLobeIconKeys(iconsDirectory: string): readonly string[] {
  const files = readdirSync(iconsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  return iconKeysFromFileNames(files);
}

export function renderLobeIconKeyDeclaration(keys: readonly string[]): string {
  return `export type LobeIconKey = ${keys.map((key) => JSON.stringify(key)).join(" | ")};\n`;
}

export function lobeIconTypePath(cachePath: string, version: string): string {
  return join(cachePath, "aio-proxy", "plugin-sdk", "lobe-icons", version, "lobe-icon-key.d.ts");
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

export function createLobeIconTypePlugin(options: {
  readonly declarationPath: string;
  readonly iconsDirectory: string;
  readonly version: string;
}): RsbuildPlugin {
  return {
    name: "aio-proxy-lobe-icon-key-type",
    apply: "build",
    setup(api) {
      const declarationPath = lobeIconTypePath(api.context.cachePath, options.version);
      if (declarationPath !== options.declarationPath) {
        throw new Error("Lobe icon declaration cache path does not match Rslib dts.alias");
      }
      const keys = readLobeIconKeys(options.iconsDirectory);
      writeAtomic(declarationPath, renderLobeIconKeyDeclaration(keys));
      api.resolve(({ resolveData }) => {
        if (resolveData.request === LOBE_ICON_KEY_SPECIFIER) resolveData.request = declarationPath;
      });
    },
  };
}
```

The implementation must not catch package resolution, directory scan, filename, duplicate, or write failures. Any such failure aborts the SDK build instead of falling back to a broad declaration or stale cache.

- [ ] **Step 4: Wire source placeholder, public types, Rslib aliasing, dependencies, and Turbo inputs**

Create `packages/plugin-sdk/src/internal/lobe-icon-key-placeholder.d.ts`:

```ts
export type LobeIconKey = string;
```

Add the private import and public types to `packages/plugin-sdk/src/oauth.ts`:

```ts
import type { LobeIconKey } from "#aio-proxy/lobe-icon-key";

export type { LobeIconKey } from "#aio-proxy/lobe-icon-key";

export type OAuthIcon =
  | LobeIconKey
  | `http://${string}`
  | `https://${string}`
  | `data:image/${string}`;
```

Add `readonly icon?: OAuthIcon;` immediately after `description?: LocalizedText` in `OAuthAdapter`.

Extend `packages/plugin-sdk/tsconfig.json` with source-only fallback resolution:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "#aio-proxy/lobe-icon-key": ["src/internal/lobe-icon-key-placeholder.d.ts"]
    }
  }
}
```

Replace `packages/plugin-sdk/rslib.config.ts` with:

```ts
import { join } from "node:path";
import { defineLibraryConfig } from "@aio-proxy/infra/rslib";
import {
  createLobeIconTypePlugin,
  prepareLobeIconTypeBuild,
  resolveLobeIconPackage,
} from "./build/lobe-icon-keys";

const rootPath = import.meta.dirname;
const lobeIcons = resolveLobeIconPackage(import.meta.url);
const lobeIconBuild = prepareLobeIconTypeBuild({
  ...lobeIcons,
  cachePath: join(rootPath, "node_modules", ".cache"),
});

export default defineLibraryConfig({
  root: rootPath,
  plugins: [createLobeIconTypePlugin({ declarationPath: lobeIconBuild.declarationPath, version: lobeIcons.version })],
  banner: { dts: lobeIconBuild.declaration },
  lib: [
    {
      id: "library",
      dts: {
        bundle: true,
      },
    },
  ],
});
```

Add the icon source as a `plugin-sdk` build dependency and root-hoist API Extractor for Rslib's Bun-isolated optional-peer lookup:

```json
// packages/plugin-sdk/package.json
{ "@lobehub/icons-static-svg": "1.93.0" }
```

```json
// package.json
{ "@microsoft/api-extractor": "7.58.11" }
```

Add `"test:artifact": "bun test ./_test/build-artifact.test.ts"` to the SDK scripts. Add `"build/**"` to the root `turbo.json` `build.inputs` array so edits to the Rslib build module invalidate Turbo's build cache. Run `rtk bun install` to update `bun.lock`.

- [ ] **Step 5: Verify GREEN through the real build artifact**

Run:

```bash
rtk bun test packages/plugin-sdk/build/lobe-icon-keys.test.ts
rtk bun run --filter @aio-proxy/plugin-sdk build
rtk bun run --filter @aio-proxy/plugin-sdk test:types
rtk bun run --filter @aio-proxy/plugin-sdk test:artifact
```

Expected: all commands pass; the build log reports bundled declaration generation; `dist/index.d.ts` contains an exact key union; runtime JavaScript contains no complete key list.

- [ ] **Step 6: Commit the SDK build contract**

```bash
git add packages/plugin-sdk turbo.json bun.lock
git commit -m "feat(plugin-sdk): generate exact oauth icon keys" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Validate and Sanitize OAuth Icons During Registry Staging

**Files:**
- Create: `packages/core/src/plugins/icon.ts`
- Create: `packages/core/_test/plugins/icon.test.ts`
- Modify: `packages/core/src/plugins/diagnostic.ts`
- Modify: `packages/core/src/plugins/index.ts`
- Modify: `packages/core/src/plugins/registry.ts`
- Modify: `packages/core/src/plugins/loader/index.ts`
- Modify: `packages/core/_test/plugins/registry.test.ts`

**Interfaces:**
- Produces: `MAX_OAUTH_ICON_BYTES = 256 * 1024`, `OAuthIconValidationResult`, and `validateOAuthIcon(value)`.
- Changes: `createPluginRegistryHost(logger?: PluginLogSink)`; omitted logger remains a no-op for direct test/host callers.
- Logging: event `plugin.oauth.icon.invalid`, code `PLUGIN_ICON_INVALID`, context `{ plugin, capability }`, safe fixed message `OAuth adapter icon was ignored`.

- [ ] **Step 1: Write failing icon classification and registry degradation tests**

Create `packages/core/_test/plugins/icon.test.ts` with this acceptance matrix:

```ts
import { describe, expect, test } from "bun:test";
import { MAX_OAUTH_ICON_BYTES, validateOAuthIcon } from "../../src/plugins/icon";

describe("validateOAuthIcon", () => {
  test.each([
    "openai",
    "codex-color",
    "http://example.com/icon.svg",
    "https://cdn.example.com/icon.webp",
    "data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E",
    "data:image/png;base64,iVBORw0KGgo=",
    "data:image/webp;base64,UklGRg==",
    "data:image/gif;base64,R0lGODlh",
    "data:image/avif;base64,AAAA",
  ])("accepts %s", (icon) => {
    expect(validateOAuthIcon(icon)).toEqual({ ok: true, value: icon });
  });

  test.each([
    1,
    "OpenAI",
    "open_ai",
    "ftp://example.com/icon.svg",
    "http:///missing-host.svg",
    "data:text/html,%3Cb%3Ex%3C%2Fb%3E",
    "data:image/jpeg;base64,/9j/",
    `data:image/png,${"a".repeat(MAX_OAUTH_ICON_BYTES)}`,
  ])("rejects an invalid icon without returning it", (icon) => {
    const result = validateOAuthIcon(icon);
    expect(result).toEqual({ ok: false });
    expect(result).not.toHaveProperty("value");
  });
});
```

Extend `packages/core/_test/plugins/registry.test.ts` with:

- one adapter using a valid icon and asserting the resolved snapshot retains it;
- one adapter using an invalid data URL and asserting the capability still commits with `icon === undefined`;
- one captured log assertion for `PLUGIN_ICON_INVALID` that verifies neither the raw data URL nor its payload appears in the serialized entry;
- one old adapter without `icon` proving unchanged behavior.

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
rtk bun test packages/core/_test/plugins/icon.test.ts packages/core/_test/plugins/registry.test.ts
```

Expected: FAIL because icon validation, the log code, logger-aware registry staging, and icon copying do not exist.

- [ ] **Step 3: Implement the runtime validator without a Lobe key table**

Create `packages/core/src/plugins/icon.ts` around this public shape:

```ts
import type { OAuthIcon } from "@aio-proxy/plugin-sdk";

export const MAX_OAUTH_ICON_BYTES = 256 * 1024;
const LOBE_ICON_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DATA_MIME = new Set(["image/svg+xml", "image/png", "image/webp", "image/gif", "image/avif"]);
const MIME_PARAMETER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[^"\\]|\\.)*")$/u;

export type OAuthIconValidationResult =
  | { readonly ok: true; readonly value: OAuthIcon }
  | { readonly ok: false };

function validDataUrl(value: string): boolean {
  const comma = value.indexOf(",");
  if (comma < 0) return false;
  const [rawMime, ...parameters] = value.slice(5, comma).split(";");
  if (!DATA_MIME.has(rawMime.toLowerCase())) return false;
  let sawBase64 = false;
  for (const [index, parameter] of parameters.entries()) {
    if (parameter.toLowerCase() === "base64") {
      if (sawBase64 || index !== parameters.length - 1) return false;
      sawBase64 = true;
    } else if (!MIME_PARAMETER.test(parameter)) return false;
  }
  try {
    new URL(value);
    const payload = decodeURIComponent(value.slice(comma + 1));
    if (sawBase64) atob(payload);
    return true;
  } catch {
    return false;
  }
}

export function validateOAuthIcon(value: unknown): OAuthIconValidationResult {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > MAX_OAUTH_ICON_BYTES) {
    return { ok: false };
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      const url = new URL(value);
      return url.hostname !== "" && (url.protocol === "http:" || url.protocol === "https:")
        ? { ok: true, value: value as OAuthIcon }
        : { ok: false };
    } catch {
      return { ok: false };
    }
  }
  if (value.startsWith("data:")) return validDataUrl(value) ? { ok: true, value: value as OAuthIcon } : { ok: false };
  return LOBE_ICON_SLUG.test(value) ? { ok: true, value: value as OAuthIcon } : { ok: false };
}
```

Do not import `@lobehub/icons-static-svg` in core and do not add a runtime key existence check.

- [ ] **Step 4: Integrate soft icon degradation into registry staging**

Extend `PluginLogCode` with `"PLUGIN_ICON_INVALID"`, export `validateOAuthIcon` from `packages/core/src/plugins/index.ts`, and change registry construction to:

```ts
const noopPluginLogger: PluginLogSink = () => {};

export function createPluginRegistryHost(logger: PluginLogSink = noopPluginLogger) {
```

In `validateAdapter`, parse the capability ID before icon handling, call `validateOAuthIcon(icon)` only when `icon !== undefined`, and use this exact warning shape when validation fails:

```ts
logger({
  event: "plugin.oauth.icon.invalid",
  code: "PLUGIN_ICON_INVALID",
  context: { plugin, capability: id },
  error: { name: "OAuthIconValidationError", message: "OAuth adapter icon was ignored" },
});
```

Reconstruct the adapter with `icon` only when validation succeeded. Never include the raw icon in the error, context, or message. Change `loadPluginRegistry()` to call `createPluginRegistryHost(options.logger)` so built-in and third-party staging warnings reach the configured sink.

- [ ] **Step 5: Verify GREEN and loader regression**

Run:

```bash
rtk bun test packages/core/_test/plugins/icon.test.ts packages/core/_test/plugins/registry.test.ts packages/core/src/plugins/loader
rtk bun run --filter @aio-proxy/core build
```

Expected: all tests and the core build pass; invalid icons yield one warning and a committed adapter without `icon`.

- [ ] **Step 6: Commit runtime icon validation**

```bash
git add packages/core
git commit -m "feat(plugins): sanitize oauth capability icons" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Assign Built-in Capability Icons and Verify the Complete Build Chain

**Files:**
- Modify: `packages/plugins/openai-chatgpt/src/plugin.ts`
- Modify: `packages/plugins/github-copilot/src/plugin.ts`
- Modify: `.changeset/oauth-plugin-system.md`

**Interfaces:**
- Consumes: exact published `LobeIconKey` union from `@aio-proxy/plugin-sdk/dist/index.d.ts`.
- Produces: OpenAI ChatGPT icon key `openai`; GitHub Copilot icon key `githubcopilot`.

- [ ] **Step 1: Add the built-in icon assignments**

In the OpenAI adapter object, add:

```ts
icon: "openai",
```

In the GitHub Copilot adapter object, add:

```ts
icon: "githubcopilot",
```

Append this sentence to `.changeset/oauth-plugin-system.md`:

```md
OAuth capabilities can now expose validated icons, including an exact build-generated LobeHub static icon key type.
```

- [ ] **Step 2: Prove built-in consumers receive the narrow artifact type**

Run the dependency-ordered build, not raw `tsc -b`:

```bash
rtk bun run build --filter=@aio-proxy/plugin-openai-chatgpt --filter=@aio-proxy/plugin-github-copilot
```

Expected: Turbo builds `@aio-proxy/plugin-sdk` first, then both built-in packages compile against `dist/index.d.ts`, and both real keys pass.

The committed SDK artifact fixture from Task 1 supplies the negative consumer assertion: if the union widens to `string`, its `@ts-expect-error` becomes unused and `test:artifact` fails. Do not mutate a built-in source file merely to test the negative case.

- [ ] **Step 3: Run complete icon verification**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-sdk test
rtk bun run --filter @aio-proxy/plugin-sdk test:artifact
rtk bun test packages/core/_test/plugins/icon.test.ts packages/core/_test/plugins/registry.test.ts
rtk bun run --filter @aio-proxy/plugin-openai-chatgpt test:unit
rtk bun run --filter @aio-proxy/plugin-github-copilot test:unit
rtk bun run check
rtk bun run preflight
```

Expected: all commands pass; no Dashboard files change; `.reference` remains untracked and untouched.

- [ ] **Step 4: Commit built-in adoption**

```bash
git add packages/plugins/openai-chatgpt/src/plugin.ts packages/plugins/github-copilot/src/plugin.ts .changeset/oauth-plugin-system.md
git commit -m "feat(plugins): declare built-in oauth icons" -m "Co-authored-by: Codex <noreply@openai.com>"
```
