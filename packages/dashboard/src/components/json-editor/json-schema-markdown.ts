import type { JsonSchema } from './json-editor-state';

const SCHEMA_MAP_KEYS = ['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas'] as const;
const SCHEMA_NODE_KEYS = [
  'items',
  'additionalProperties',
  'additionalItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'not',
  'contains',
  'propertyNames',
  'if',
  'then',
  'else',
] as const;
const SCHEMA_ARRAY_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;

const isSchemaObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const mapSchemaRecord = (value: unknown): unknown => {
  if (!isSchemaObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, isSchemaObject(child) ? withMarkdownDescriptions(child) : child]),
  );
};

const mapSchemaNode = (value: unknown): unknown => {
  if (isSchemaObject(value)) return withMarkdownDescriptions(value);
  if (Array.isArray(value))
    return value.map((child) => (isSchemaObject(child) ? withMarkdownDescriptions(child) : child));
  return value;
};

export const withMarkdownDescriptions = (schema: JsonSchema): JsonSchema => {
  const next: Record<string, unknown> = { ...schema };
  if (typeof next.description === 'string' && next.markdownDescription === undefined) {
    next.markdownDescription = next.description;
  }

  for (const key of SCHEMA_MAP_KEYS) {
    if (key in next) next[key] = mapSchemaRecord(next[key]);
  }
  for (const key of SCHEMA_NODE_KEYS) {
    if (key in next) next[key] = mapSchemaNode(next[key]);
  }
  for (const key of SCHEMA_ARRAY_KEYS) {
    if (key in next) next[key] = mapSchemaNode(next[key]);
  }

  return next;
};
