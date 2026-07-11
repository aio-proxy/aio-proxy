import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { RsbuildPlugin } from "@aio-proxy/infra/rslib";
import { Script } from "typebox";
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

describe("provider schema generation", () => {
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

  test("generates the exact allowlist with required compatible-provider fields and descriptions", async () => {
    const generated = await generateProviderSchemaEntries();
    expect(Object.keys(generated.entries)).toEqual(PROVIDER_SCHEMA_ALLOWLIST.map(({ packageName }) => packageName));
    expect(generated.dependencies).toContainEqual(expect.stringMatching(/@ai-sdk\/openai-compatible\/package\.json$/));
    expect(generated.dependencies).toContainEqual(expect.stringMatching(/\.d\.ts$/));

    const compatible = generated.entries["@ai-sdk/openai-compatible"];
    expect(compatible.schema).not.toBeNull();
    expect(compatible.schema?.required).toEqual(expect.arrayContaining(["name", "baseURL"]));
    expect(compatible.schema?.properties).toMatchObject({
      name: { description: expect.any(String) },
      baseURL: { description: expect.any(String) },
    });

    const openRouter = generated.entries["@openrouter/ai-sdk-provider"];
    expect(openRouter.schema).not.toBeNull();
    expect(openRouter.warnings).toContainEqual({ code: "unsupported_optional", path: "fetch" });
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
    expect(beforeBuildRegistrations).toBe(0);
  });

  test("returns generated source and tracks every generation dependency", async () => {
    const rootPath = mkdtempSync(join(tmpdir(), "provider-schema-plugin-handler-root-"));
    let registration: TransformRegistration | undefined;
    const logs: string[] = [];
    const importedModules: string[] = [];
    let importedGeneratorCalls = 0;
    pluginProviderSchemas().setup({
      transform(descriptor, handler) {
        registration = { descriptor, handler };
      },
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
          generateProviderSchemaEntries(onDependency?: (dependency: string) => void) {
            importedGeneratorCalls++;
            return generateProviderSchemaEntries(onDependency);
          },
          renderGeneratedProviderSchemas,
        });
      },
    } as Parameters<TransformRegistration["handler"]>[0]);
    const generated = await generateProviderSchemaEntries();
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
    const repositoryRoot = join(import.meta.dir, "../../..");
    const build = Bun.spawnSync(["bun", "run", "--filter", "@aio-proxy/provider-schemas", "build"], {
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(build.exitCode, `${build.stdout.toString()}\n${build.stderr.toString()}`).toBe(0);
    const built = await readFile(join(import.meta.dir, "../dist/schema-module.js"), "utf8");
    const source = await readFile(join(import.meta.dir, "../src/schema-module.ts"), "utf8");
    expect(built).toContain("@ai-sdk/openai-compatible");
    expect(source).not.toContain("@ai-sdk/openai-compatible");
  });
});
