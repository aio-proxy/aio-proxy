import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "typebox";
import {
  compileTypeBoxModule,
  generateProviderSchemaEntries,
  generateProviderSchemaEntry,
  renderGeneratedProviderSchemas,
} from "../scripts/generate-provider-schemas";
import { normalizeTypeBoxModule } from "../scripts/schema-normalizer";
import { PROVIDER_SCHEMA_ALLOWLIST } from "../src/allowlist";

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

  test("committed generated source is current", async () => {
    const expected = renderGeneratedProviderSchemas((await generateProviderSchemaEntries()).entries);
    const actual = await readFile(join(import.meta.dir, "../src/generated.ts"), "utf8");
    expect(actual).toBe(expected);
  });
});
