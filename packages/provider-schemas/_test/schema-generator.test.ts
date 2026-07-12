import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { RsbuildPlugin } from "@aio-proxy/infra/rslib";
import { Script } from "typebox";
import { PROVIDER_SCHEMAS_BUILD_EXTERNALS } from "../rslib.config";
import { generateProviderSchemaEntries } from "../scripts/provider-schemas-build";
import {
  compileTypeBoxModule,
  generateProviderSchemaEntry,
  renderGeneratedProviderSchemas,
} from "../scripts/provider-schemas-generator";
import { pluginProviderSchemas } from "../scripts/provider-schemas-plugin";
import { normalizeTypeBoxModule } from "../scripts/schema-normalizer";
import { PROVIDER_SCHEMA_ALLOWLIST } from "../src/allowlist";

type PluginApi = Parameters<RsbuildPlugin["setup"]>[0];
type TransformRegistration = {
  readonly descriptor: Parameters<PluginApi["transform"]>[0];
  readonly handler: Parameters<PluginApi["transform"]>[1];
};
type BeforeBuildHandler = Parameters<PluginApi["onBeforeBuild"]>[0];

const EXPECTED_PROVIDER_SCHEMA_CATALOG = [
  { packageName: "@ai-sdk/gateway", factoryName: "createGateway" },
  { packageName: "@ai-sdk/xai", factoryName: "createXai" },
  { packageName: "@ai-sdk/vercel", factoryName: "createVercel" },
  { packageName: "@ai-sdk/openai", factoryName: "createOpenAI" },
  { packageName: "@ai-sdk/azure", factoryName: "createAzure" },
  { packageName: "@ai-sdk/anthropic", factoryName: "createAnthropic" },
  { packageName: "@ai-sdk/open-responses", factoryName: "createOpenResponses" },
  { packageName: "@ai-sdk/anthropic-aws", factoryName: "createAnthropicAws" },
  { packageName: "@ai-sdk/amazon-bedrock", factoryName: "createAmazonBedrock" },
  { packageName: "@ai-sdk/groq", factoryName: "createGroq" },
  { packageName: "@ai-sdk/fal", factoryName: "createFal" },
  { packageName: "@ai-sdk/deepinfra", factoryName: "createDeepInfra" },
  { packageName: "@ai-sdk/black-forest-labs", factoryName: "createBlackForestLabs" },
  { packageName: "@ai-sdk/google", factoryName: "createGoogle" },
  { packageName: "@ai-sdk/google-vertex", factoryName: "createGoogleVertex" },
  { packageName: "@ai-sdk/mistral", factoryName: "createMistral" },
  { packageName: "@ai-sdk/togetherai", factoryName: "createTogetherAI" },
  { packageName: "@ai-sdk/cohere", factoryName: "createCohere" },
  { packageName: "@ai-sdk/fireworks", factoryName: "createFireworks" },
  { packageName: "@ai-sdk/voyage", factoryName: "createVoyage" },
  { packageName: "@ai-sdk/deepseek", factoryName: "createDeepSeek" },
  { packageName: "@ai-sdk/moonshotai", factoryName: "createMoonshotAI" },
  { packageName: "@ai-sdk/alibaba", factoryName: "createAlibaba" },
  { packageName: "@ai-sdk/cerebras", factoryName: "createCerebras" },
  { packageName: "@ai-sdk/replicate", factoryName: "createReplicate" },
  { packageName: "@ai-sdk/prodia", factoryName: "createProdia" },
  { packageName: "@ai-sdk/perplexity", factoryName: "createPerplexity" },
  { packageName: "@ai-sdk/luma", factoryName: "createLuma" },
  { packageName: "@ai-sdk/bytedance", factoryName: "createByteDance" },
  { packageName: "@ai-sdk/klingai", factoryName: "createKlingAI" },
  { packageName: "@ai-sdk/elevenlabs", factoryName: "createElevenLabs" },
  { packageName: "@ai-sdk/assemblyai", factoryName: "createAssemblyAI" },
  { packageName: "@ai-sdk/deepgram", factoryName: "createDeepgram" },
  { packageName: "@ai-sdk/gladia", factoryName: "createGladia" },
  { packageName: "@ai-sdk/lmnt", factoryName: "createLMNT" },
  { packageName: "@ai-sdk/hume", factoryName: "createHume" },
  { packageName: "@ai-sdk/revai", factoryName: "createRevai" },
  { packageName: "@ai-sdk/baseten", factoryName: "createBaseten" },
  { packageName: "@ai-sdk/huggingface", factoryName: "createHuggingFace" },
  { packageName: "@ai-sdk/quiverai", factoryName: "createQuiverAI" },
  { packageName: "@ai-sdk/openai-compatible", factoryName: "createOpenAICompatible" },
  { packageName: "@openrouter/ai-sdk-provider", factoryName: "createOpenRouter" },
] as const;

const createFixtureProvider = () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "provider-schema-generation-fixture-"));
  const source = { packageName: "fixture-provider", factoryName: "createFixture" } as const;
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: source.packageName, version: "1.0.0", types: "./index.d.ts" }),
  );
  writeFileSync(
    join(packageRoot, "index.d.ts"),
    `
      /** Options for the fixture provider. */
      export interface FixtureOptions {
        /** Provider display name. */
        name: string;
        /** Provider API base URL. */
        baseURL: string;
        fetch?: typeof fetch;
      }
      export declare function createFixture(options: FixtureOptions): unknown;
    `,
  );
  return {
    packageRoot,
    source,
    options: {
      cacheRoot: join(packageRoot, "cache"),
      refreshLatest: false,
      sources: [source],
      resolveSource: async () => packageRoot,
    },
  };
};

describe("provider schema generation", () => {
  test("uses standard ESM imports for provider schema build dependencies", async () => {
    const scriptsRoot = join(import.meta.dir, "../scripts");
    expect(existsSync(join(scriptsRoot, "provider-schemas-require.ts"))).toBe(false);
    expect(PROVIDER_SCHEMAS_BUILD_EXTERNALS).toEqual({
      "node:crypto": 'var process.getBuiltinModule("node:crypto")',
      "node:fs/promises": 'var process.getBuiltinModule("node:fs/promises")',
      "node:path": 'var process.getBuiltinModule("node:path")',
    });
    for (const name of [
      "declaration-entry.ts",
      "declaration-parser.ts",
      "provider-schemas-generator.ts",
      "provider-source-cache.ts",
    ]) {
      expect(await readFile(join(scriptsRoot, name), "utf8")).not.toContain("providerSchemasRequire");
    }
  });

  test("pins the exact allowlist without provider dependencies", async () => {
    expect(PROVIDER_SCHEMA_ALLOWLIST).toEqual(EXPECTED_PROVIDER_SCHEMA_CATALOG);
    const packageJson = JSON.parse(await readFile(join(import.meta.dir, "../package.json"), "utf8"));
    for (const { packageName } of EXPECTED_PROVIDER_SCHEMA_CATALOG) {
      expect(packageJson.dependencies?.[packageName]).toBeUndefined();
      expect(packageJson.devDependencies?.[packageName]).toBeUndefined();
    }
  });

  test("disables Turbo caching for npm-latest provider schema builds", async () => {
    const turbo = JSON.parse(await readFile(join(import.meta.dir, "../../../turbo.json"), "utf8"));
    const genericBuild = turbo.tasks.build;
    const providerBuild = turbo.tasks["@aio-proxy/provider-schemas#build"];

    expect(providerBuild).toEqual({ ...genericBuild, cache: false });
  });

  test("TypeBox exposes the non-exported synthetic root alias", () => {
    const module = Script(`
      type __AioProxyProviderOptions = NonNullable<Options>;
      interface Options { apiKey?: string }
      type LaterUnsupportedDeclaration = MissingNamespace.Type;
    `);
    expect(module).toHaveProperty("__AioProxyProviderOptions");
  });

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
        Options: {
          type: "object",
          required: ["fetch"],
          properties: { optional: { type: "symbol" }, fetch: { type: "function" } },
        },
      },
      documentation: {},
    });
    expect(required.schema).toBeNull();
    expect(required.warnings).toEqual([{ code: "unsupported_optional", path: "optional" }]);
  });

  test("converts typeof fetch so optional fields drop and required fields reject", () => {
    const optionalModule = compileTypeBoxModule(`
      type __AioProxyProviderOptions = Options;
      interface Options { fetch?: typeof fetch; name?: string }
    `);
    expect(
      normalizeTypeBoxModule({
        rootName: "__AioProxyProviderOptions",
        module: optionalModule,
        documentation: {},
      }),
    ).toMatchObject({
      schema: { properties: { name: { type: "string" } } },
      warnings: [{ code: "unsupported_optional", path: "fetch" }],
    });

    const requiredModule = compileTypeBoxModule(`
      type __AioProxyProviderOptions = Options;
      interface Options { fetch: typeof fetch }
    `);
    expect(
      normalizeTypeBoxModule({
        rootName: "__AioProxyProviderOptions",
        module: requiredModule,
        documentation: {},
      }).schema,
    ).toBeNull();
  });

  test("typeof fetch compatibility conversion preserves literals and property names", () => {
    const module = compileTypeBoxModule(`
      type __AioProxyProviderOptions = Options;
      interface Options {
        label?: "typeof fetch";
        "typeof fetch"?: string;
        fetch?: typeof fetch;
      }
    `);
    expect(
      normalizeTypeBoxModule({
        rootName: "__AioProxyProviderOptions",
        module,
        documentation: {},
      }),
    ).toMatchObject({
      schema: {
        properties: {
          label: { const: "typeof fetch" },
          "typeof fetch": { type: "string" },
        },
      },
      warnings: [{ code: "unsupported_optional", path: "fetch" }],
    });
  });

  test("normalizes refs, nested objects, unsupported unions, and JSDoc", () => {
    const result = normalizeTypeBoxModule({
      rootName: "Options",
      module: {
        Shared: { type: "object", required: ["token"], properties: { token: { type: "string" } } },
        Callback: { type: "function", parameters: [], returnType: { type: "void" } },
        Options: {
          type: "object",
          properties: {
            shared: { $ref: "Shared" },
            nested: { type: "object", properties: { count: { type: "number" } } },
            mixed: { anyOf: [{ type: "string" }, { type: "symbol" }] },
            indexed: { type: "deferred", action: "Index", parameters: [{ $ref: "Missing" }] },
            headers: {
              type: "object",
              patternProperties: { ".*": { anyOf: [{ type: "string" }, { type: "undefined" }] } },
            },
            callback: { $ref: "Callback" },
          },
        },
      },
      documentation: {
        Options: "Provider options.",
        "Options.shared": "Shared credentials.",
        "Shared.token": "Authentication token.",
      },
    });

    expect(result.schema).toEqual({
      type: "object",
      description: "Provider options.",
      additionalProperties: true,
      properties: {
        shared: { $ref: "#/$defs/Shared", description: "Shared credentials." },
        nested: {
          type: "object",
          additionalProperties: true,
          properties: { count: { type: "number" } },
        },
      },
      $defs: {
        Shared: {
          type: "object",
          additionalProperties: true,
          required: ["token"],
          properties: { token: { type: "string", description: "Authentication token." } },
        },
      },
    });
    expect(result.warnings).toEqual([
      { code: "unsupported_optional", path: "callback" },
      { code: "unsupported_optional", path: "headers" },
      { code: "unresolved_optional", path: "indexed" },
      { code: "unsupported_optional", path: "mixed" },
    ]);
  });

  test("generates configured sources with required fields and descriptions", async () => {
    const fixture = createFixtureProvider();
    const generated = await generateProviderSchemaEntries(fixture.options);
    expect(Object.keys(generated.entries)).toEqual([fixture.source.packageName]);
    expect(generated.dependencies).toContain(join(realpathSync(fixture.packageRoot), "package.json"));
    expect(generated.dependencies).toContainEqual(expect.stringMatching(/\.d\.ts$/));

    const entry = generated.entries[fixture.source.packageName];
    expect(entry.schema).not.toBeNull();
    expect(entry.schema?.required).toEqual(expect.arrayContaining(["name", "baseURL"]));
    expect(entry.schema?.properties).toMatchObject({
      name: { description: expect.any(String) },
      baseURL: { description: expect.any(String) },
    });
    expect(entry.warnings).toContainEqual({ code: "unsupported_optional", path: "fetch" });
  });

  test("preserves declaration JSDoc on the generated root schema", async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "provider-schema-root-doc-"));
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "fixture-provider", version: "1.0.0", types: "./index.d.ts" }),
    );
    writeFileSync(
      join(packageRoot, "index.d.ts"),
      `
        /** Options for the fixture provider. */
        export interface FixtureOptions { apiKey?: string }
        export declare function createFixture(options: FixtureOptions): unknown;
      `,
    );

    const generated = await generateProviderSchemaEntry(packageRoot, {
      packageName: "fixture-provider",
      factoryName: "createFixture",
    });

    expect(generated.entry.schema).toMatchObject({ description: "Options for the fixture provider." });
    expect(renderGeneratedProviderSchemas({ "fixture-provider": generated.entry })).toContain(
      '"description": "Options for the fixture provider."',
    );
  });

  test("generates schemas for aliased relative factory parameter imports", async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "provider-schema-aliased-parameter-"));
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "fixture-provider", version: "1.0.0", types: "./index.d.ts" }),
    );
    writeFileSync(
      join(packageRoot, "index.d.ts"),
      `
        import type { OriginalOptions as LocalOptions } from "./options";
        export declare function createFixture(options: LocalOptions): unknown;
      `,
    );
    writeFileSync(join(packageRoot, "options.d.ts"), "export interface OriginalOptions { apiKey: string }\n");

    const generated = await generateProviderSchemaEntry(packageRoot, {
      packageName: "fixture-provider",
      factoryName: "createFixture",
    });

    expect(generated.entry.schema).not.toBeNull();
    expect(generated.entry.schema?.properties).toMatchObject({ apiKey: { type: "string" } });
  });

  test("generates schemas for nested aliased relative property imports", async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "provider-schema-aliased-property-"));
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "fixture-provider", version: "1.0.0", types: "./index.d.ts" }),
    );
    writeFileSync(
      join(packageRoot, "index.d.ts"),
      `
        import type { OriginalOptions as LocalOptions } from "./options";
        export interface FixtureOptions { nested?: LocalOptions }
        export declare function createFixture(options: FixtureOptions): unknown;
      `,
    );
    writeFileSync(join(packageRoot, "options.d.ts"), "export interface OriginalOptions { apiKey: string }\n");

    const generated = await generateProviderSchemaEntry(packageRoot, {
      packageName: "fixture-provider",
      factoryName: "createFixture",
    });

    expect(generated.entry.schema).not.toBeNull();
    expect(JSON.stringify(generated.entry.schema)).toContain('"nested"');
    expect(JSON.stringify(generated.entry.schema)).toContain('"apiKey"');
  });

  test("canonicalizes package root dependencies", async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "provider-schema-canonical-root-"));
    const canonicalRoot = realpathSync(packageRoot);
    const linkedRoot = join(mkdtempSync(join(tmpdir(), "provider-schema-linked-root-")), "provider");
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "fixture-provider", version: "1.0.0", types: "./index.d.ts" }),
    );
    writeFileSync(
      join(packageRoot, "index.d.ts"),
      "export declare function createFixture(options: { apiKey?: string }): unknown;\n",
    );
    symlinkSync(packageRoot, linkedRoot, "dir");

    const generated = await generateProviderSchemaEntry(linkedRoot, {
      packageName: "fixture-provider",
      factoryName: "createFixture",
    });

    expect(generated.dependencies.every(isAbsolute)).toBe(true);
    expect(generated.dependencies).toEqual(
      [join(canonicalRoot, "index.d.ts"), join(canonicalRoot, "package.json")].sort(),
    );
  });

  test("registers manifest and traversed declarations before generation failure", async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "provider-schema-failure-dependencies-"));
    const entry = join(packageRoot, "index.d.ts");
    const factory = join(packageRoot, "factory.d.ts");
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "fixture-provider", version: "1.0.0", types: "./index.d.ts" }),
    );
    writeFileSync(entry, 'export { createFixture } from "./factory";\n');
    writeFileSync(factory, "export declare function createFixture( invalid syntax\n");
    const dependencies: string[] = [];

    await expect(
      generateProviderSchemaEntry(
        packageRoot,
        { packageName: "fixture-provider", factoryName: "createFixture" },
        (dependency) => dependencies.push(dependency),
      ),
    ).rejects.toThrow();

    expect(dependencies).toEqual([join(packageRoot, "package.json"), entry, factory].map(realpathSync));
  });

  test("registers the manifest before malformed package metadata fails", async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "provider-schema-malformed-manifest-"));
    const manifest = join(packageRoot, "package.json");
    writeFileSync(manifest, "{");
    const dependencies: string[] = [];

    await expect(
      generateProviderSchemaEntry(
        packageRoot,
        { packageName: "fixture-provider", factoryName: "createFixture" },
        (dependency) => dependencies.push(dependency),
      ),
    ).rejects.toThrow();

    expect(dependencies).toEqual([realpathSync(manifest)]);
  });

  test("renders schemas deterministically", () => {
    const entry = {
      packageName: "fixture",
      packageVersion: "1.0.0",
      factoryName: "createFixture",
      schema: { type: "object", properties: { z: { type: "string" }, a: { type: "number" } } },
      warnings: [
        { code: "unsupported_optional" as const, path: "z" },
        { code: "unsupported_optional" as const, path: "a" },
      ],
    };
    expect(renderGeneratedProviderSchemas({ z: entry, a: entry })).toBe(
      renderGeneratedProviderSchemas({ a: entry, z: entry }),
    );
  });

  test("uses locale-independent code-unit ordering", () => {
    const entry = {
      packageName: "fixture",
      packageVersion: "1.0.0",
      factoryName: "createFixture",
      schema: { type: "object", properties: { a: { type: "number" }, Z: { type: "string" } } },
      warnings: [
        { code: "unsupported_optional" as const, path: "a" },
        { code: "unsupported_optional" as const, path: "Z" },
      ],
    };
    const rendered = renderGeneratedProviderSchemas({ a: entry, Z: entry });

    expect(rendered.indexOf('  "Z": {')).toBeLessThan(rendered.indexOf('  "a": {'));
    expect(rendered.indexOf('"path": "Z"')).toBeLessThan(rendered.indexOf('"path": "a"'));
  });

  test("uses dist package exports and an empty physical schema module", async () => {
    const packageJson = JSON.parse(await readFile(join(import.meta.dir, "../package.json"), "utf8"));
    const source = await readFile(join(import.meta.dir, "../src/schema-module.ts"), "utf8");

    expect(packageJson.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    });
    expect(packageJson.scripts).not.toHaveProperty("generate");
    expect(source).toContain("Readonly<Record<string, ProviderOptionsSchemaEntry>> = {};");
    expect(source).not.toContain("@ai-sdk/openai-compatible");
  });

  test("registers a build-only transform for the generated module", () => {
    const plugin = pluginProviderSchemas();
    const rootPath = mkdtempSync(join(tmpdir(), "provider-schema-plugin-root-"));
    let registration: TransformRegistration | undefined;
    let beforeBuildRegistrations = 0;

    plugin.setup({
      transform(descriptor, handler) {
        registration = { descriptor, handler };
      },
      onBeforeBuild() {
        beforeBuildRegistrations++;
      },
      context: { rootPath },
      logger: { info() {} },
    } as unknown as PluginApi);

    expect(plugin.name).toBe("aio-proxy:provider-schemas");
    expect(plugin.apply).toBe("build");
    expect(registration?.descriptor.test).toBe(join(rootPath, "src/schema-module.ts"));
    expect(registration?.descriptor.order).toBe("pre");
    expect(beforeBuildRegistrations).toBe(1);
  });

  test("selects latest refresh policy from Rslib watch mode", async () => {
    const rootPath = mkdtempSync(join(tmpdir(), "provider-schema-plugin-policy-root-"));
    mkdirSync(join(rootPath, "src"));
    const physicalModulePath = join(rootPath, "src/schema-module.ts");
    const physicalSource = "physical placeholder source";
    writeFileSync(physicalModulePath, physicalSource);
    let registration: TransformRegistration | undefined;
    let beforeBuild: BeforeBuildHandler | undefined;
    const generateCalls: { options: unknown }[] = [];

    pluginProviderSchemas().setup({
      transform(descriptor, handler) {
        registration = { descriptor, handler };
      },
      onBeforeBuild(handler) {
        beforeBuild = handler;
      },
      context: { rootPath },
      logger: { info() {} },
    } as unknown as PluginApi);

    expect(beforeBuild).toBeDefined();
    const transformContext = {
      code: physicalSource,
      addDependency() {},
      importModule() {
        return Promise.resolve({
          generateProviderSchemaEntries(options: unknown) {
            generateCalls.push({ options });
            return Promise.resolve({ entries: {}, dependencies: [] });
          },
          renderGeneratedProviderSchemas,
        });
      },
    } as Parameters<TransformRegistration["handler"]>[0];
    await registration?.handler(transformContext);
    expect(generateCalls.at(-1)?.options).toEqual({
      cacheRoot: join(rootPath, "node_modules/.cache/provider-schemas/v2"),
      refreshLatest: true,
    });

    expect(await beforeBuild?.({ isWatch: true, isFirstCompile: true })).toBeUndefined();
    expect(generateCalls).toHaveLength(1);
    expect(await readFile(physicalModulePath, "utf8")).toBe(physicalSource);
    await registration?.handler(transformContext);
    expect(generateCalls.at(-1)?.options).toEqual({
      cacheRoot: join(rootPath, "node_modules/.cache/provider-schemas/v2"),
      refreshLatest: false,
    });

    expect(await beforeBuild?.({ isWatch: false, isFirstCompile: true })).toBeUndefined();
    expect(generateCalls).toHaveLength(2);
    expect(await readFile(physicalModulePath, "utf8")).toBe(physicalSource);
    await registration?.handler(transformContext);
    expect(generateCalls.at(-1)?.options).toEqual({
      cacheRoot: join(rootPath, "node_modules/.cache/provider-schemas/v2"),
      refreshLatest: true,
    });
  });

  test("returns generated source and tracks every generation dependency", async () => {
    const rootPath = mkdtempSync(join(tmpdir(), "provider-schema-plugin-handler-root-"));
    const fixture = createFixtureProvider();
    let registration: TransformRegistration | undefined;
    const logs: string[] = [];
    const importedModules: string[] = [];
    let importedGeneratorCalls = 0;
    pluginProviderSchemas().setup({
      transform(descriptor, handler) {
        registration = { descriptor, handler };
      },
      onBeforeBuild() {},
      context: { rootPath },
      logger: {
        info(message) {
          logs.push(String(message));
        },
      },
    } as unknown as PluginApi);

    const source = "physical placeholder source";
    const dependencies: string[] = [];
    const result = await registration?.handler({
      code: source,
      addDependency(dependency) {
        dependencies.push(dependency);
      },
      importModule(request) {
        importedModules.push(request);
        return Promise.resolve({
          generateProviderSchemaEntries(
            options: { readonly cacheRoot: string; readonly refreshLatest: boolean },
            onDependency?: (dependency: string) => void,
          ) {
            importedGeneratorCalls++;
            return generateProviderSchemaEntries(
              { ...options, sources: [fixture.source], resolveSource: async () => fixture.packageRoot },
              onDependency,
            );
          },
          renderGeneratedProviderSchemas,
        });
      },
    } as Parameters<TransformRegistration["handler"]>[0]);
    const generated = await generateProviderSchemaEntries(fixture.options);
    const expected = renderGeneratedProviderSchemas(generated.entries);

    expect(result).toBe(expected);
    expect([...dependencies].sort()).toEqual(generated.dependencies);
    expect(new Set(dependencies).size).toBe(dependencies.length);
    expect(dependencies).toContainEqual(expect.stringMatching(/package\.json$/));
    expect(dependencies).toContainEqual(expect.stringMatching(/\.d\.ts$/));
    expect(importedModules).toEqual([join(rootPath, "scripts/provider-schemas-build.ts")]);
    expect(importedGeneratorCalls).toBe(1);
    expect(logs).toEqual([`provider schemas: ${Object.keys(generated.entries).length} generated`]);
  });

  test("builds generated schemas only into dist", async () => {
    const fixture = createFixtureProvider();
    const generated = await generateProviderSchemaEntries(fixture.options);
    const generatedSource = renderGeneratedProviderSchemas(generated.entries);
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "../src/schema-module.ts")],
      target: "bun",
      plugins: [
        {
          name: "fixture-provider-schemas",
          setup(builder) {
            builder.onLoad({ filter: /schema-module\.ts$/ }, () => ({ contents: generatedSource, loader: "ts" }));
          },
        },
      ],
    });

    expect(build.success).toBe(true);
    const built = await build.outputs[0]?.text();
    const source = await readFile(join(import.meta.dir, "../src/schema-module.ts"), "utf8");
    expect(built).toContain(fixture.source.packageName);
    expect(source).not.toContain(fixture.source.packageName);
  });

  test("loads the production provider schema build graph through a real Rslib transform", async () => {
    const repositoryRoot = join(import.meta.dir, "../../..");
    const buildRoot = mkdtempSync(join(tmpdir(), "provider-schema-build-rslib-"));
    mkdirSync(join(buildRoot, "src"));
    writeFileSync(join(buildRoot, "src/index.ts"), "export const fixture = true;\n");
    const fixture = createFixtureProvider();
    writeFileSync(
      join(buildRoot, "rslib.config.ts"),
      `
        export default {
          source: { entry: { index: "./src/index.ts" } },
          lib: [{ format: "esm", bundle: false }],
          output: { target: "node" },
          tools: { rspack: { externals: ${JSON.stringify(PROVIDER_SCHEMAS_BUILD_EXTERNALS)} } },
          plugins: [{
            name: "fixture:provider-source-cache-import",
            setup(api) {
              api.transform({ test: /index\\.ts$/ }, async ({ code, importModule }) => {
                const generator = await importModule(${JSON.stringify(join(import.meta.dir, "../scripts/provider-schemas-build.ts"))});
                const generated = await generator.generateProviderSchemaEntries({
                  cacheRoot: ${JSON.stringify(join(buildRoot, "cache"))},
                  refreshLatest: false,
                  sources: [{ packageName: ${JSON.stringify(fixture.source.packageName)}, factoryName: ${JSON.stringify(fixture.source.factoryName)} }],
                  resolveSource: async () => ${JSON.stringify(fixture.packageRoot)},
                });
                return "export const fixture = " + JSON.stringify(generated.entries) + ";";
              });
            },
          }],
        };
      `,
    );
    const build = Bun.spawnSync(["bunx", "rslib", "build", "--root", buildRoot], {
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(build.exitCode, `${build.stdout.toString()}\n${build.stderr.toString()}`).toBe(0);
    expect(await readFile(join(buildRoot, "dist/index.js"), "utf8")).toContain(fixture.source.packageName);
  });
});
