import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProviderPackageMetadata, resolveDeclarationEntry } from "../scripts/declaration-entry";
import { parseProviderFactoryDeclaration } from "../scripts/declaration-parser";

const fixtureRoot = (name: string) => mkdtempSync(join(tmpdir(), `${name}-`));

describe("provider schema declaration inputs", () => {
  test("resolves exports.types before types and typings", async () => {
    const root = fixtureRoot("provider-schema-entry");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture-provider",
        version: "1.0.0",
        types: "./fallback.d.ts",
        typings: "./legacy.d.ts",
        exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      }),
    );
    mkdirSync(join(root, "dist"));
    writeFileSync(
      join(root, "dist/index.d.ts"),
      "export declare function createFixture(options: { apiKey?: string }): unknown;\n",
    );

    expect(await resolveDeclarationEntry(root)).toBe(realpathSync(join(root, "dist/index.d.ts")));
    expect(await readProviderPackageMetadata(root)).toEqual({
      name: "fixture-provider",
      version: "1.0.0",
    });
  });

  test("falls back from types to typings", async () => {
    const typesRoot = fixtureRoot("provider-schema-types");
    writeFileSync(
      join(typesRoot, "package.json"),
      JSON.stringify({ name: "types-provider", version: "1.0.0", types: "./index.d.ts" }),
    );
    writeFileSync(join(typesRoot, "index.d.ts"), "export {};\n");

    const typingsRoot = fixtureRoot("provider-schema-typings");
    writeFileSync(
      join(typingsRoot, "package.json"),
      JSON.stringify({ name: "typings-provider", version: "1.0.0", typings: "./index.d.ts" }),
    );
    writeFileSync(join(typingsRoot, "index.d.ts"), "export {};\n");

    expect(await resolveDeclarationEntry(typesRoot)).toBe(realpathSync(join(typesRoot, "index.d.ts")));
    expect(await resolveDeclarationEntry(typingsRoot)).toBe(realpathSync(join(typingsRoot, "index.d.ts")));
  });

  test("rejects declaration entries that escape the package root", async () => {
    const parent = fixtureRoot("provider-schema-escape");
    const root = join(parent, "package");
    mkdirSync(root);
    writeFileSync(join(parent, "outside.d.ts"), "export {};\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "escape-provider", version: "1.0.0", types: "../outside.d.ts" }),
    );

    await expect(resolveDeclarationEntry(root)).rejects.toThrow("outside package root");
  });

  test("extracts the configured factory parameter and JSDoc", async () => {
    const root = fixtureRoot("provider-schema-parser");
    const entry = join(root, "index.d.ts");
    writeFileSync(
      entry,
      `
        /** Settings used by the fixture provider. */
        export interface FixtureSettings {
          /** API key used for authentication. */
          apiKey?: string;
        }
        export declare function createFixture(options?: FixtureSettings): unknown;
      `,
    );

    const parsed = await parseProviderFactoryDeclaration({
      packageRoot: root,
      declarationEntry: entry,
      factoryName: "createFixture",
    });

    expect(parsed.parameterType).toBe("FixtureSettings");
    expect(parsed.optional).toBe(true);
    expect(parsed.declarations).toHaveLength(1);
    expect(parsed.declarations[0]).toContain("interface FixtureSettings");
    expect(parsed.documentation.FixtureSettings).toBe("Settings used by the fixture provider.");
    expect(parsed.documentation["FixtureSettings.apiKey"]).toBe("API key used for authentication.");
    expect(parsed.sourceFiles).toEqual([realpathSync(entry)]);
  });

  test("extracts property JSDoc from object type aliases", async () => {
    const root = fixtureRoot("provider-schema-type-alias-docs");
    const entry = join(root, "index.d.ts");
    writeFileSync(
      entry,
      `
        export type FixtureSettings = {
          /** API key used for authentication. */
          apiKey?: string;
        };
        export declare function createFixture(options: FixtureSettings): unknown;
      `,
    );

    const parsed = await parseProviderFactoryDeclaration({
      packageRoot: root,
      declarationEntry: entry,
      factoryName: "createFixture",
    });

    expect(parsed.documentation["FixtureSettings.apiKey"]).toBe("API key used for authentication.");
  });

  test("does not collect declaration names found only in property keys, comments, or literals", async () => {
    const root = fixtureRoot("provider-schema-reference-noise");
    const entry = join(root, "index.d.ts");
    writeFileSync(
      entry,
      `
        export interface Foo {}
        export interface FixtureSettings {
          Foo?: string;
          /** Foo is mentioned only in documentation. */
          label?: "Foo";
        }
        export declare function createFixture(options: FixtureSettings): unknown;
      `,
    );

    const parsed = await parseProviderFactoryDeclaration({
      packageRoot: root,
      declarationEntry: entry,
      factoryName: "createFixture",
    });

    expect(parsed.declarations).toHaveLength(1);
    expect(parsed.declarations[0]).toContain("interface FixtureSettings");
  });

  test("collects declarations referenced by property value types", async () => {
    const root = fixtureRoot("provider-schema-type-reference");
    const entry = join(root, "index.d.ts");
    writeFileSync(
      entry,
      `
        export interface Foo {}
        export interface FixtureSettings { value?: Foo; }
        export declare function createFixture(options: FixtureSettings): unknown;
      `,
    );

    const parsed = await parseProviderFactoryDeclaration({
      packageRoot: root,
      declarationEntry: entry,
      factoryName: "createFixture",
    });

    expect(parsed.declarations).toHaveLength(2);
    expect(parsed.declarations.join("\n")).toContain("interface Foo");
  });

  test("follows relative re-exports and imports while preserving declaration text", async () => {
    const root = fixtureRoot("provider-schema-reexport");
    const entry = join(root, "index.d.ts");
    const factory = join(root, "factory.d.ts");
    const shared = join(root, "shared.d.ts");
    writeFileSync(entry, 'export { createFixture } from "./factory";\n');
    writeFileSync(
      factory,
      `
        import type { SharedSettings } from "./shared";
        export interface FixtureSettings extends SharedSettings {
          /** Optional endpoint. */
          baseURL?: string;
        }
        export declare const createFixture: (options: FixtureSettings) => unknown;
      `,
    );
    writeFileSync(
      shared,
      `
        export interface SharedSettings {
          /** Shared token. */
          token: string;
        }
      `,
    );

    const parsed = await parseProviderFactoryDeclaration({
      packageRoot: root,
      declarationEntry: entry,
      factoryName: "createFixture",
    });

    expect(parsed.parameterType).toBe("FixtureSettings");
    expect(parsed.optional).toBe(false);
    expect(parsed.declarations.join("\n")).toContain("interface FixtureSettings extends SharedSettings");
    expect(parsed.declarations.join("\n")).toContain("interface SharedSettings");
    expect(parsed.documentation["FixtureSettings.baseURL"]).toBe("Optional endpoint.");
    expect(parsed.documentation["SharedSettings.token"]).toBe("Shared token.");
    expect(parsed.sourceFiles).toEqual([entry, factory, shared].map(realpathSync).sort());
  });

  test("handles relative declaration cycles", async () => {
    const root = fixtureRoot("provider-schema-cycle");
    const entry = join(root, "index.d.ts");
    writeFileSync(entry, 'export { createFixture } from "./factory";\n');
    writeFileSync(
      join(root, "factory.d.ts"),
      `
        import type { SharedSettings } from "./shared";
        export interface FixtureSettings extends SharedSettings {}
        export declare function createFixture(options: FixtureSettings): unknown;
      `,
    );
    writeFileSync(
      join(root, "shared.d.ts"),
      `
        import type { FixtureSettings } from "./factory";
        export interface SharedSettings { nested?: FixtureSettings; }
      `,
    );

    const parsed = await parseProviderFactoryDeclaration({
      packageRoot: root,
      declarationEntry: entry,
      factoryName: "createFixture",
    });

    expect(parsed.declarations).toHaveLength(2);
  });

  test("follows imported factory exports and type export stars", async () => {
    const root = fixtureRoot("provider-schema-barrels");
    const entry = join(root, "index.d.ts");
    writeFileSync(entry, 'import { createFixture } from "./factory"; export { createFixture };\n');
    writeFileSync(
      join(root, "factory.d.ts"),
      'import type { FixtureSettings } from "./settings"; export declare function createFixture(options: FixtureSettings): unknown;\n',
    );
    writeFileSync(join(root, "settings.d.ts"), 'export * from "./settings-value";\n');
    writeFileSync(join(root, "settings-value.d.ts"), "export interface FixtureSettings { token: string; }\n");

    const parsed = await parseProviderFactoryDeclaration({
      packageRoot: root,
      declarationEntry: entry,
      factoryName: "createFixture",
    });

    expect(parsed.parameterType).toBe("FixtureSettings");
    expect(parsed.declarations[0]).toContain("interface FixtureSettings");
  });

  test("rejects relative traversal deeper than sixteen files", async () => {
    const root = fixtureRoot("provider-schema-depth");
    const entry = join(root, "index.d.ts");
    writeFileSync(
      entry,
      'import type { Type1 } from "./type-1"; export declare function createFixture(options: Type1): unknown;\n',
    );
    for (let index = 1; index <= 17; index += 1) {
      const next = index === 17 ? "string" : `Type${index + 1}`;
      const importLine = index === 17 ? "" : `import type { ${next} } from "./type-${index + 1}";`;
      writeFileSync(
        join(root, `type-${index}.d.ts`),
        `${importLine} export interface Type${index} { next?: ${next}; }\n`,
      );
    }

    await expect(
      parseProviderFactoryDeclaration({
        packageRoot: root,
        declarationEntry: entry,
        factoryName: "createFixture",
      }),
    ).rejects.toThrow("depth limit");
  });

  test("rejects more than sixty-four declaration files", async () => {
    const root = fixtureRoot("provider-schema-files");
    const entry = join(root, "index.d.ts");
    const exports = Array.from({ length: 64 }, (_, index) => `export * from "./type-${index}";`).join("\n");
    writeFileSync(
      entry,
      `${exports}\nexport declare function createFixture(options: RootSettings): unknown;\nexport interface RootSettings {}\n`,
    );
    for (let index = 0; index < 64; index += 1) {
      writeFileSync(join(root, `type-${index}.d.ts`), `export interface Type${index} {}\n`);
    }

    await expect(
      parseProviderFactoryDeclaration({
        packageRoot: root,
        declarationEntry: entry,
        factoryName: "createFixture",
      }),
    ).rejects.toThrow("file limit");
  });

  test("rejects more than four MiB of declaration source", async () => {
    const root = fixtureRoot("provider-schema-source");
    const entry = join(root, "index.d.ts");
    writeFileSync(
      entry,
      `export interface HugeSettings { value: "${"x".repeat(4 * 1024 * 1024)}"; }\nexport declare function createFixture(options: HugeSettings): unknown;\n`,
    );

    await expect(
      parseProviderFactoryDeclaration({
        packageRoot: root,
        declarationEntry: entry,
        factoryName: "createFixture",
      }),
    ).rejects.toThrow("source limit");
  });
});
