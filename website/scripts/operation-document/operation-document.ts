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

function hasReferenceMarker(value: unknown, visited = new WeakSet<object>()): boolean {
  if (typeof value !== 'object' || value === null || visited.has(value)) return false;
  visited.add(value);
  if (!Array.isArray(value) && Object.hasOwn(value, '$ref')) return true;
  return Object.values(value).some((item) => hasReferenceMarker(item, visited));
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
  const parameters = mergeParameters(selected.pathItem, selected.operation);
  if (parameters !== undefined) projected.parameters = parameters;
  if (!Object.hasOwn(projected, 'servers') && Object.hasOwn(selected.pathItem, 'servers')) {
    projected.servers = selected.pathItem.servers;
  }
  return projected;
}

export function projectOperation(document: OpenApiDocument, operationId: string): OpenApiDocument {
  if (hasReferenceMarker(document)) throw new OperationProjectionError('Unresolved reference marker');

  const selected = findOperation(document, operationId);
  const { paths: _paths, ...root } = document;
  return {
    ...root,
    paths: { [selected.path]: { [selected.method]: projectSelectedOperation(selected) } },
  } as OpenApiDocument;
}
