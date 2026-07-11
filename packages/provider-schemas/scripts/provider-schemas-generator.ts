import { PROVIDER_SCHEMA_ALLOWLIST } from "../src/allowlist";
import type { ProviderOptionsSchemaEntry } from "../src/types";
import { readProviderPackageMetadata, resolveDeclarationEntry } from "./declaration-entry";
import { parseProviderFactoryDeclaration } from "./declaration-parser";
import { providerSchemasRequire } from "./provider-schemas-require";
import { type ProviderSchemaSource, resolveProviderSource } from "./provider-source-cache";
import { normalizeTypeBoxModule } from "./schema-normalizer";

const { realpath } = providerSchemasRequire("node:fs/promises") as typeof import("node:fs/promises");
const { join } = providerSchemasRequire("node:path") as typeof import("node:path");
const { parse } = providerSchemasRequire("@babel/parser") as typeof import("@babel/parser");
const { Script } = providerSchemasRequire("typebox") as typeof import("typebox");

const ROOT_NAME = "__AioProxyProviderOptions";
const compareCodeUnits = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export type ProviderSchemaDependencyCallback = (dependency: string) => void;

export type GenerateProviderSchemasOptions = {
  readonly cacheRoot: string;
  readonly refreshLatest: boolean;
  readonly sources?: readonly ProviderSchemaSource[];
  readonly resolveSource?: typeof resolveProviderSource;
};

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

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
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
  onDependency?: ProviderSchemaDependencyCallback,
): Promise<GeneratedProviderSchemaEntry> => {
  const dependencies = new Set<string>();
  const addDependency = (dependency: string) => {
    if (dependencies.has(dependency)) return;
    dependencies.add(dependency);
    onDependency?.(dependency);
  };
  const canonicalPackageRoot = await realpath(packageRoot);
  addDependency(join(canonicalPackageRoot, "package.json"));
  const declarationEntry = await resolveDeclarationEntry(canonicalPackageRoot);
  const [metadata, parsed] = await Promise.all([
    readProviderPackageMetadata(canonicalPackageRoot),
    parseProviderFactoryDeclaration({
      packageRoot: canonicalPackageRoot,
      declarationEntry,
      factoryName: source.factoryName,
      onDependency: addDependency,
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
    dependencies: [...dependencies].sort(compareCodeUnits),
  };
};

export const generateProviderSchemaEntries = async (
  options: GenerateProviderSchemasOptions,
  onDependency?: ProviderSchemaDependencyCallback,
): Promise<GeneratedProviderSchemas> => {
  const sources = options.sources ?? PROVIDER_SCHEMA_ALLOWLIST;
  const resolveSource = options.resolveSource ?? resolveProviderSource;
  const entries: Record<string, ProviderOptionsSchemaEntry> = {};
  const dependencies = new Set<string>();
  const addDependency = (dependency: string) => {
    if (dependencies.has(dependency)) return;
    dependencies.add(dependency);
    onDependency?.(dependency);
  };
  for (const allowlisted of sources) {
    const packageRoot = await resolveSource(allowlisted, options);
    const generated = await generateProviderSchemaEntry(packageRoot, allowlisted, addDependency);
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
