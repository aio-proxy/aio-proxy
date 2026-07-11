import type { JsonSchema, ProviderOptionsSchemaWarning } from "../src/types";

type Schema = Record<string, unknown> & {
  $defs?: unknown;
  $ref?: unknown;
  additionalProperties?: unknown;
  description?: unknown;
  properties?: unknown;
  required?: unknown;
  type?: unknown;
};

export type NormalizeTypeBoxModuleOptions = {
  readonly rootName: string;
  readonly module: Readonly<Record<string, unknown>>;
  readonly documentation: Readonly<Record<string, string>>;
};

export type NormalizedTypeBoxModule = {
  readonly schema: JsonSchema | null;
  readonly warnings: readonly ProviderOptionsSchemaWarning[];
};

type Failure = { readonly failure: "unsupported" | "unresolved" | "fatal" };
type Result = Schema | Failure;

const unsupportedTypes = new Set(["function", "symbol", "bigint", "undefined"]);
const isSchema = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFailure = (value: Result): value is Failure => "failure" in value;

export const normalizeTypeBoxModule = ({
  rootName,
  module,
  documentation,
}: NormalizeTypeBoxModuleOptions): NormalizedTypeBoxModule => {
  const warnings: ProviderOptionsSchemaWarning[] = [];
  const sortedWarnings = () =>
    warnings.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
  const definitions: Record<string, Schema> = {};
  const definitionState = new Map<string, "visiting" | "done" | Failure["failure"]>();

  const normalizeDefinition = (name: string): Result => {
    const source = module[name];
    if (!isSchema(source)) return { failure: "unresolved" };
    const state = definitionState.get(name);
    if (state === "visiting" || state === "done") return { $ref: `#/$defs/${name}` };
    if (state === "unsupported" || state === "unresolved" || state === "fatal") return { failure: state };

    definitionState.set(name, "visiting");
    const normalized = normalize(source, name, "");
    if (isFailure(normalized)) {
      definitionState.set(name, normalized.failure);
      return normalized;
    }
    const description = documentation[name];
    definitions[name] = description ? { ...normalized, description } : normalized;
    definitionState.set(name, "done");
    return { $ref: `#/$defs/${name}` };
  };

  const normalizeArray = (value: unknown, declarationName: string, path: string): Result[] | Failure => {
    if (!Array.isArray(value)) return { failure: "unsupported" };
    const normalized = value.map((item) => (isSchema(item) ? normalize(item, declarationName, path) : item));
    const failure = normalized.find((item): item is Failure => isSchema(item) && "failure" in item);
    return failure ?? (normalized as Result[]);
  };

  function normalize(source: Schema, declarationName: string, path: string): Result {
    if (typeof source.$ref === "string") {
      const name = source.$ref.replace(/^#?\/?\$defs\//, "");
      return normalizeDefinition(name);
    }
    if (typeof source.type === "string" && unsupportedTypes.has(source.type)) {
      return { failure: "unsupported" };
    }
    if (source.type === "deferred") return { failure: "unresolved" };

    const output: Schema = {};
    for (const [key, value] of Object.entries(source)) {
      if (key === "properties" || key === "$defs" || key === "$ref" || key === "additionalProperties") continue;
      if (["anyOf", "allOf", "oneOf", "prefixItems"].includes(key)) {
        const normalized = normalizeArray(value, declarationName, path);
        if (!Array.isArray(normalized)) return normalized;
        output[key] = normalized;
      } else if (["items", "contains", "not", "if", "then", "else", "propertyNames"].includes(key) && isSchema(value)) {
        const normalized = normalize(value, declarationName, path);
        if (isFailure(normalized)) return normalized;
        output[key] = normalized;
      } else if (["patternProperties", "dependentSchemas"].includes(key) && isSchema(value)) {
        const normalizedEntries: Schema = {};
        for (const [name, item] of Object.entries(value)) {
          if (!isSchema(item)) continue;
          const normalized = normalize(item, declarationName, path);
          if (isFailure(normalized)) return normalized;
          normalizedEntries[name] = normalized;
        }
        output[key] = normalizedEntries;
      } else {
        output[key] = value;
      }
    }

    if (source.type === "object" || isSchema(source.properties)) {
      output.type = source.type ?? "object";
      output.additionalProperties = true;
      const required = new Set(
        Array.isArray(source.required)
          ? source.required.filter((item): item is string => typeof item === "string")
          : [],
      );
      const properties: Schema = {};
      for (const [property, value] of Object.entries(isSchema(source.properties) ? source.properties : {})) {
        if (!isSchema(value)) continue;
        const propertyPath = path ? `${path}.${property}` : property;
        const normalized = normalize(value, declarationName, propertyPath);
        if (isFailure(normalized)) {
          if (normalized.failure === "fatal" || required.has(property)) return { failure: "fatal" };
          warnings.push({
            code: normalized.failure === "unresolved" ? "unresolved_optional" : "unsupported_optional",
            path: propertyPath,
          });
          continue;
        }
        const description = documentation[`${declarationName}.${property}`];
        properties[property] = description ? { ...normalized, description } : normalized;
      }
      output.properties = properties;
    }

    return output;
  }

  const root = module[rootName];
  if (!isSchema(root)) return { schema: null, warnings: [] };
  const schema = normalize(root, rootName, "");
  if (isFailure(schema)) return { schema: null, warnings: sortedWarnings() };
  const description = documentation[rootName];
  if (description) schema.description = description;
  if (Object.keys(definitions).length > 0) schema.$defs = definitions;
  return { schema, warnings: sortedWarnings() };
};
