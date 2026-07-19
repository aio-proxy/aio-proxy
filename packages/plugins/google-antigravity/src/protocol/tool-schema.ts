type KnownField =
  | "$ref"
  | "allOf"
  | "anyOf"
  | "const"
  | "description"
  | "enum"
  | "functionCallingConfig"
  | "items"
  | "oneOf"
  | "properties"
  | "required"
  | "toolConfig"
  | "type";

export type JsonObject = Record<string, unknown> & Partial<Record<KnownField, unknown>>;

const MOVED_CONSTRAINTS = [
  "additionalProperties",
  "minLength",
  "maxLength",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "format",
  "default",
  "examples",
] as const;

const UNSUPPORTED = new Set([
  ..."$defs $id $schema $comment patternProperties unevaluatedProperties dependentSchemas if then else not".split(" "),
  ...MOVED_CONSTRAINTS,
]);

export class AntigravityToolSchemaValidationError extends TypeError {
  override readonly name = "AntigravityToolSchemaValidationError";
}

export function normalizeAntigravityToolSchema(input: unknown, options: { readonly root: boolean }): JsonObject {
  const converted = convertRefsConstsEnumsAndHints(cloneJsonObject(input));
  const flattened = flattenCompositionsAndTypeArrays(converted);
  const cleaned = removeUnsupportedAndInvalidRequired(flattened);
  return addRequiredPlaceholder(cleaned, options.root);
}

export function normalizeFunctionDeclarations(input: unknown): JsonObject[] {
  if (!Array.isArray(input)) throw validationError();
  return input.map((value) => {
    if (!isObject(value)) throw validationError();
    const { parametersJsonSchema, parameters, ...declaration } = value;
    const hasJsonSchema = Object.hasOwn(value, "parametersJsonSchema");
    const hasParameters = Object.hasOwn(value, "parameters");
    if (!hasJsonSchema && !hasParameters) return { ...declaration };
    const normalized = normalizeAntigravityToolSchema(hasJsonSchema ? parametersJsonSchema : parameters, {
      root: true,
    });
    if (normalized.type !== "object") throw validationError();
    return { ...declaration, parameters: normalized };
  });
}

export function applyValidatedToolMode(request: Readonly<JsonObject>, claudeBacked: boolean): JsonObject {
  if (!claudeBacked) return { ...request };
  const toolConfig = objectOrEmpty(request.toolConfig);
  const functionCallingConfig = objectOrEmpty(toolConfig.functionCallingConfig);
  return {
    ...request,
    toolConfig: {
      ...toolConfig,
      functionCallingConfig: { ...functionCallingConfig, mode: "VALIDATED" },
    },
  };
}

function convertRefsConstsEnumsAndHints(schema: JsonObject): JsonObject {
  const converted = mapChildren(schema, convertRefsConstsEnumsAndHints);
  if (Object.hasOwn(converted, "$ref")) {
    const reference = typeof converted.$ref === "string" ? converted.$ref.split("/").at(-1) : undefined;
    const description = appendHint(converted.description, reference === undefined ? undefined : `See: ${reference}`);
    return { type: "object", ...(description === undefined ? {} : { description }) };
  }

  const result = { ...converted };
  if (Object.hasOwn(result, "const")) {
    result.enum = [result.const];
    delete result.const;
  }
  if (Array.isArray(result.enum)) {
    const values = result.enum.map(stringValue);
    if (values.length === 0) {
      delete result.enum;
    } else {
      result.enum = values;
      result.type = "string";
      if (values.length >= 2 && values.length <= 10) {
        result.description = appendHint(result.description, `Allowed values: ${values.join(", ")}`);
      }
    }
  }
  for (const hint of constraintHints(result)) {
    result.description = appendHint(result.description, hint);
  }
  return result;
}

function flattenCompositionsAndTypeArrays(schema: JsonObject): JsonObject {
  let result = mapChildren(schema, flattenCompositionsAndTypeArrays);
  if (Array.isArray(result.allOf)) {
    const branches = result.allOf.filter(isObject);
    const properties = Object.assign(
      {},
      objectOrEmpty(result.properties),
      ...branches.map((item) => objectOrEmpty(item.properties)),
    );
    const required = uniqueStrings([
      ...arrayOrEmpty(result.required),
      ...branches.flatMap((item) => arrayOrEmpty(item.required)),
    ]);
    const { allOf: _allOf, ...rest } = result;
    result = {
      ...rest,
      ...(Object.keys(properties).length === 0 ? {} : { type: "object", properties }),
      ...(required.length === 0 ? {} : { required }),
    };
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    if (!Array.isArray(result[keyword])) continue;
    const choices = result[keyword].filter(isObject);
    const selected =
      choices.reduce<JsonObject | undefined>(
        (best, choice) => (best === undefined || schemaPriority(choice) > schemaPriority(best) ? choice : best),
        undefined,
      ) ?? {};
    const labels = uniqueStrings(choices.map(schemaLabel));
    const { [keyword]: _composition, ...rest } = result;
    result = mergeSchemas(selected, rest);
    result.description = appendHint(
      result.description,
      labels.length === 0 ? undefined : `Accepts: ${labels.join(", ")}`,
    );
  }
  if (Array.isArray(result.type)) {
    const types = uniqueStrings(result.type);
    const selected = types.find((type) => type !== "null") ?? types[0];
    if (selected === undefined) delete result.type;
    else result.type = selected;
    result.description = appendHint(result.description, types.length < 2 ? undefined : `Accepts: ${types.join(", ")}`);
  }
  return result;
}

function removeUnsupportedAndInvalidRequired(schema: JsonObject): JsonObject {
  const result = mapChildren(schema, removeUnsupportedAndInvalidRequired);
  for (const keyword of Object.keys(result)) {
    if (UNSUPPORTED.has(keyword) || keyword.startsWith("x-") || keyword === "$ref") delete result[keyword];
  }
  const properties = isObject(result.properties) ? result.properties : undefined;
  if (result.properties !== undefined && properties === undefined) delete result.properties;
  const required = uniqueStrings(arrayOrEmpty(result.required)).filter((name) => properties?.[name] !== undefined);
  if (required.length === 0) delete result.required;
  else result.required = required;
  return result;
}

function addRequiredPlaceholder(schema: JsonObject, root: boolean): JsonObject {
  const result = mapChildren(schema, (child) => addRequiredPlaceholder(child, false));
  const properties = isObject(result.properties) ? result.properties : undefined;
  const objectSchema = result.type === "object" || properties !== undefined || (root && result.type === undefined);
  if (!objectSchema) return result;
  if (root && (properties === undefined || Object.keys(properties).length === 0)) {
    return {
      ...result,
      type: "object",
      properties: {
        reason: { type: "string", description: "Brief explanation of why you are calling this tool" },
      },
      required: ["reason"],
    };
  }
  if (!root && properties !== undefined && Object.keys(properties).length > 0 && !Array.isArray(result.required)) {
    return {
      ...result,
      type: "object",
      properties: { ...properties, _: { type: "boolean", description: "Optional placeholder" } },
      required: ["_"],
    };
  }
  return result.type === undefined && properties !== undefined ? { ...result, type: "object" } : result;
}

function mapChildren(schema: JsonObject, transform: (input: JsonObject) => JsonObject): JsonObject {
  const result = { ...schema };
  if (isObject(result.properties)) {
    result.properties = Object.fromEntries(
      Object.entries(result.properties).map(([name, value]) => [name, isObject(value) ? transform(value) : value]),
    );
  }
  if (isObject(result.items)) result.items = transform(result.items);
  else if (Array.isArray(result.items))
    result.items = result.items.map((item) => (isObject(item) ? transform(item) : item));
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(result[keyword])) {
      result[keyword] = result[keyword].map((item) => (isObject(item) ? transform(item) : item));
    }
  }
  return result;
}

function constraintHints(schema: JsonObject): string[] {
  const labels: Readonly<Record<(typeof MOVED_CONSTRAINTS)[number], string>> = {
    additionalProperties: "No additional properties",
    minLength: "Minimum length",
    maxLength: "Maximum length",
    exclusiveMinimum: "Exclusive minimum",
    exclusiveMaximum: "Exclusive maximum",
    pattern: "Pattern",
    minItems: "Minimum items",
    maxItems: "Maximum items",
    uniqueItems: "Unique items",
    format: "Format",
    default: "Default",
    examples: "Examples",
  };
  return MOVED_CONSTRAINTS.flatMap((keyword) => {
    if (!Object.hasOwn(schema, keyword) || (keyword === "additionalProperties" && schema[keyword] !== false)) return [];
    return [`${labels[keyword]}: ${stringValue(schema[keyword])}`];
  });
}

function mergeSchemas(left: JsonObject, right: JsonObject): JsonObject {
  const properties = { ...objectOrEmpty(left.properties), ...objectOrEmpty(right.properties) };
  const required = uniqueStrings([...arrayOrEmpty(left.required), ...arrayOrEmpty(right.required)]);
  return {
    ...left,
    ...right,
    ...(Object.keys(properties).length === 0 ? {} : { properties }),
    ...(required.length === 0 ? {} : { required }),
  };
}

function schemaPriority(schema: JsonObject): number {
  const label = schemaLabel(schema);
  if (label === "object") return 4;
  if (label === "array") return 3;
  if (label === "null") return 1;
  return 2;
}

function schemaLabel(schema: JsonObject): string {
  if (typeof schema.type === "string") return schema.type;
  if (isObject(schema.properties)) return "object";
  if (schema.items !== undefined) return "array";
  return "value";
}

function appendHint(description: unknown, hint: string | undefined): string | undefined {
  const current = typeof description === "string" && description.length > 0 ? description : undefined;
  if (hint === undefined || current?.includes(hint)) return current;
  return current === undefined ? hint : `${current} (${hint})`;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

function cloneJsonObject(input: unknown): JsonObject {
  if (!isObject(input)) throw validationError();
  return structuredClone(input);
}

function validationError(): AntigravityToolSchemaValidationError {
  return new AntigravityToolSchemaValidationError("Function declaration parameters must be an object schema");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectOrEmpty(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string"))];
}
