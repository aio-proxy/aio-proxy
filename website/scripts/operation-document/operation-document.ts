import type { validate } from '@scalar/openapi-parser';

type ValidationResult = Awaited<ReturnType<typeof validate>>;
export type OpenApiDocument = Extract<ValidationResult, { valid: true }>['specification'];

type DataObject = Record<string, unknown>;
type SelectedOperation = {
  readonly method: string;
  readonly path: string;
  readonly pathItem: DataObject;
  readonly operation: DataObject;
};

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query'] as const;

export class OperationProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationProjectionError';
  }
}

const isDataObject = (value: unknown): value is DataObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type ReferenceScanContext = 'openapi' | 'schema' | 'schema-map';

const SCHEMA_DATA_FIELDS = new Set(['default', 'example', 'examples', 'const', 'enum']);
const SCHEMA_MAP_FIELDS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

// Reference Objects and literal payload data both allow a `$ref` key, so keep schema maps and data fields distinct.
function hasReferenceMarker(
  value: unknown,
  visited = new WeakMap<object, Set<ReferenceScanContext>>(),
  context: ReferenceScanContext = 'openapi',
): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const contexts = visited.get(value);
  if (contexts?.has(context)) return false;
  if (contexts === undefined) visited.set(value, new Set([context]));
  else contexts.add(context);
  if (isDataObject(value) && typeof value.$ref === 'string') return true;
  return Object.entries(value).some(([key, item]) => {
    if (context !== 'schema-map' && (key === 'example' || key === 'value')) return false;
    if (context === 'schema' && SCHEMA_DATA_FIELDS.has(key)) return false;

    const childContext =
      context === 'schema-map'
        ? 'schema'
        : key === 'schema'
          ? 'schema'
          : key === 'schemas' || key === 'definitions' || (context === 'schema' && SCHEMA_MAP_FIELDS.has(key))
            ? 'schema-map'
            : context;
    return hasReferenceMarker(item, visited, childContext);
  });
}

function findOperation(document: OpenApiDocument, operationId: string): SelectedOperation {
  const paths = isDataObject(document.paths) ? document.paths : {};
  const seen = new Set<string>();
  let selected: SelectedOperation | undefined;

  for (const [path, value] of Object.entries(paths)) {
    if (!isDataObject(value)) continue;
    for (const method of HTTP_METHODS) {
      const operation = value[method];
      if (operation === undefined) continue;
      if (!isDataObject(operation) || typeof operation.operationId !== 'string' || operation.operationId === '') {
        throw new OperationProjectionError(`Missing operationId for ${method.toUpperCase()} ${path}`);
      }
      if (seen.has(operation.operationId)) {
        throw new OperationProjectionError(`Duplicate operationId "${operation.operationId}"`);
      }
      seen.add(operation.operationId);
      if (operation.operationId === operationId) selected = { method, path, pathItem: value, operation };
    }
  }

  if (selected === undefined) throw new OperationProjectionError(`Missing operationId "${operationId}"`);
  return selected;
}

const parameterKey = (parameter: unknown): string | undefined => {
  if (!isDataObject(parameter) || typeof parameter.name !== 'string' || typeof parameter.in !== 'string') {
    return undefined;
  }
  return `${parameter.in}\0${parameter.name}`;
};

function mergeParameters(pathItem: DataObject, operation: DataObject): unknown[] | undefined {
  const inherited = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
  const own = Array.isArray(operation.parameters) ? operation.parameters : [];
  if (!Object.hasOwn(pathItem, 'parameters') && !Object.hasOwn(operation, 'parameters')) return undefined;

  const merged = [...inherited];
  const positions = new Map(merged.map((parameter, index) => [parameterKey(parameter), index]));
  for (const parameter of own) {
    const position = positions.get(parameterKey(parameter));
    if (position === undefined) {
      positions.set(parameterKey(parameter), merged.length);
      merged.push(parameter);
    } else {
      merged[position] = parameter;
    }
  }
  return merged;
}

function projectSelectedOperation(selected: SelectedOperation): DataObject {
  const projected = { ...selected.operation };
  for (const field of ['summary', 'description'] as const) {
    if (!Object.hasOwn(projected, field) && Object.hasOwn(selected.pathItem, field)) {
      projected[field] = selected.pathItem[field];
    }
  }
  const parameters = mergeParameters(selected.pathItem, selected.operation);
  if (parameters !== undefined) projected.parameters = parameters;
  if (!Object.hasOwn(projected, 'servers') && Object.hasOwn(selected.pathItem, 'servers')) {
    projected.servers = selected.pathItem.servers;
  }
  if (Array.isArray(projected.tags) && projected.tags.length > 1) projected.tags = projected.tags.slice(0, 1);
  return projected;
}

export function projectOperation(document: OpenApiDocument, operationId: string): OpenApiDocument {
  if (hasReferenceMarker(document)) throw new OperationProjectionError('Unresolved reference marker');

  const selected = findOperation(document, operationId);
  const { paths: _paths, webhooks: _webhooks, ...root } = document as OpenApiDocument & { webhooks?: unknown };
  const operation = projectSelectedOperation(selected);
  const selectedTag = Array.isArray(operation.tags) ? operation.tags[0] : undefined;
  const tags =
    typeof selectedTag === 'string' && Array.isArray(root.tags)
      ? root.tags.filter((tag) => isDataObject(tag) && tag.name === selectedTag)
      : root.tags;
  return {
    ...root,
    tags,
    paths: { [selected.path]: { [selected.method]: operation } },
  } as OpenApiDocument;
}
