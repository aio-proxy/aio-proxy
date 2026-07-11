import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { Script } from "typebox";
import { PROVIDER_SCHEMA_ALLOWLIST } from "../src/allowlist";
import type { ProviderOptionsSchemaEntry } from "../src/types";
import { readProviderPackageMetadata, resolveDeclarationEntry } from "./declaration-entry";
import { parseProviderFactoryDeclaration } from "./declaration-parser";
import { normalizeTypeBoxModule } from "./schema-normalizer";

const ROOT_NAME = "__AioProxyProviderOptions";
const generatedPath = fileURLToPath(new URL("../src/generated.ts", import.meta.url));
const compareCodeUnits = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export const compileTypeBoxModule = (source: string): Readonly<Record<string, unknown>> => {
  // TypeBox 1.3.6 aborts an interface containing `typeof fetch`; a function schema
  // preserves the unsupported shape so normalization can apply requiredness policy.
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const ranges: { readonly start: number; readonly end: number }[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const node = value as {
      readonly type?: unknown;
      readonly start?: number | null;
      readonly end?: number | null;
      readonly exprName?: { readonly type?: unknown; readonly name?: unknown };
    };
    if (
      node.type === "TSTypeQuery" &&
      node.exprName?.type === "Identifier" &&
      node.exprName.name === "fetch" &&
      node.start != null &&
      node.end != null
    ) {
      ranges.push({ start: node.start, end: node.end });
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(ast);
  const compatibleSource = ranges
    .sort((left, right) => right.start - left.start)
    .reduce((text, range) => `${text.slice(0, range.start)}() => unknown${text.slice(range.end)}`, source);
  return Script(compatibleSource) as unknown as Readonly<Record<string, unknown>>;
};

const findPackageRoot = async (packageName: string) => {
  let directory = dirname(fileURLToPath(import.meta.resolve(packageName)));
  for (;;) {
    try {
      const packageJson: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if ((packageJson as { readonly name?: unknown }).name === packageName) return directory;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate package root for ${packageName}`);
    directory = parent;
  }
};

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
};

type ProviderSchemaSource = {
  readonly packageName: string;
  readonly factoryName: string;
};

export type GeneratedProviderSchemaEntry = {
  readonly entry: ProviderOptionsSchemaEntry;
  readonly dependencies: readonly string[];
};

export type GeneratedProviderSchemas = {
  readonly entries: Readonly<Record<string, ProviderOptionsSchemaEntry>>;
  readonly dependencies: readonly string[];
};

export const generateProviderSchemaEntry = async (
  packageRoot: string,
  source: ProviderSchemaSource,
): Promise<GeneratedProviderSchemaEntry> => {
  const canonicalPackageRoot = await realpath(packageRoot);
  const declarationEntry = await resolveDeclarationEntry(canonicalPackageRoot);
  const [metadata, parsed] = await Promise.all([
    readProviderPackageMetadata(canonicalPackageRoot),
    parseProviderFactoryDeclaration({
      packageRoot: canonicalPackageRoot,
      declarationEntry,
      factoryName: source.factoryName,
    }),
  ]);
  const moduleSource = [`type ${ROOT_NAME} = NonNullable<${parsed.parameterType}>;`, ...parsed.declarations].join(
    "\n\n",
  );
  const parameterDeclaration = parsed.parameterType.match(/^[$A-Z_a-z][$\w]*/)?.[0];
  const documentation = { ...parsed.documentation };
  if (parameterDeclaration) {
    const rootDescription = parsed.documentation[parameterDeclaration];
    if (rootDescription) documentation[ROOT_NAME] = rootDescription;
    for (const [key, description] of Object.entries(parsed.documentation)) {
      if (key.startsWith(`${parameterDeclaration}.`)) {
        documentation[`${ROOT_NAME}${key.slice(parameterDeclaration.length)}`] = description;
      }
    }
  }
  const normalized = normalizeTypeBoxModule({
    rootName: ROOT_NAME,
    module: compileTypeBoxModule(moduleSource),
    documentation,
  });
  return {
    entry: {
      packageName: metadata.name,
      packageVersion: metadata.version,
      factoryName: source.factoryName,
      schema: normalized.schema,
      warnings: normalized.warnings,
    },
    dependencies: [join(canonicalPackageRoot, "package.json"), ...parsed.sourceFiles].sort(compareCodeUnits),
  };
};

export const generateProviderSchemaEntries = async (): Promise<GeneratedProviderSchemas> => {
  const entries: Record<string, ProviderOptionsSchemaEntry> = {};
  const dependencies = new Set<string>();
  for (const allowlisted of PROVIDER_SCHEMA_ALLOWLIST) {
    const packageRoot = await findPackageRoot(allowlisted.packageName);
    const generated = await generateProviderSchemaEntry(packageRoot, allowlisted);
    entries[allowlisted.packageName] = generated.entry;
    for (const dependency of generated.dependencies) dependencies.add(dependency);
  }
  return { entries, dependencies: [...dependencies].sort(compareCodeUnits) };
};

export const renderGeneratedProviderSchemas = (
  entries: Readonly<Record<string, ProviderOptionsSchemaEntry>>,
): string => {
  const sorted = Object.fromEntries(
    Object.entries(entries)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, entry]) => [
        key,
        sortValue({
          ...entry,
          warnings: [...entry.warnings].sort((left, right) => compareCodeUnits(left.path, right.path)),
        }),
      ]),
  );
  const serialized = JSON.stringify(sorted, null, 2);
  return [
    "// biome-ignore-all format: This file is deterministically generated.",
    'import type { ProviderOptionsSchemaEntry } from "./types";',
    "",
    `export const PROVIDER_OPTIONS_SCHEMAS = ${serialized} as const satisfies Readonly<Record<string, ProviderOptionsSchemaEntry>>;`,
    "",
  ].join("\n");
};

export const writeGeneratedProviderSchemas = async () => {
  const source = renderGeneratedProviderSchemas((await generateProviderSchemaEntries()).entries);
  const current = await readFile(generatedPath, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (current !== source) await writeFile(generatedPath, source);
};

if (import.meta.main) await writeGeneratedProviderSchemas();
