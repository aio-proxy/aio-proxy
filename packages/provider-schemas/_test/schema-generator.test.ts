import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Script } from "typebox";
import {
  compileTypeBoxModule,
  generateProviderSchemaEntries,
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
    const entries = await generateProviderSchemaEntries();
    expect(Object.keys(entries)).toEqual(PROVIDER_SCHEMA_ALLOWLIST.map(({ packageName }) => packageName));

    const compatible = entries["@ai-sdk/openai-compatible"];
    expect(compatible.schema).not.toBeNull();
    expect(compatible.schema?.required).toEqual(expect.arrayContaining(["name", "baseURL"]));
    expect(compatible.schema?.properties).toMatchObject({
      name: { description: expect.any(String) },
      baseURL: { description: expect.any(String) },
    });

    const openRouter = entries["@openrouter/ai-sdk-provider"];
    expect(openRouter.schema).not.toBeNull();
    expect(openRouter.warnings).toContainEqual({ code: "unsupported_optional", path: "fetch" });
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

  test("committed generated source is current", async () => {
    const expected = renderGeneratedProviderSchemas(await generateProviderSchemaEntries());
    const actual = await readFile(join(import.meta.dir, "../src/generated.ts"), "utf8");
    expect(actual).toBe(expected);
  });
});
