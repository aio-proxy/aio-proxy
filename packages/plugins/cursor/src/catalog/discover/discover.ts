import type { ModelCatalog, ModelDescriptor } from '@aio-proxy/plugin-sdk';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import { GetUsableModelsRequestSchema, GetUsableModelsResponseSchema } from '../../gen/agent_pb';
import { buildDiscoveryHeaders, CURSOR_GET_USABLE_MODELS_PATH, type CursorTransport } from '../../wire';
import { decodeConnectUnaryBody } from '../../wire/unary';
import { fetchCursorFamilies } from '../available-models';
import { staticCursorCatalog } from '../catalog';

export class CursorCatalogError extends Error {
  override readonly name = 'CursorCatalogError';

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function discoverCursorModels(input: {
  readonly accessToken: string;
  readonly transport: CursorTransport;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<ModelCatalog> {
  const usablePromise = fetchGetUsableModels(input);
  const familiesPromise = fetchCursorFamilies(input).then(
    (families) => families,
    () => undefined,
  );
  const [catalog, cursorFamilies] = await Promise.all([usablePromise, familiesPromise]);
  return cursorFamilies === undefined || cursorFamilies.length === 0
    ? catalog
    : { ...catalog, metadata: { cursorFamilies } };
}

async function fetchGetUsableModels(input: {
  readonly accessToken: string;
  readonly transport: CursorTransport;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<ModelCatalog> {
  const body = toBinary(GetUsableModelsRequestSchema, create(GetUsableModelsRequestSchema, { customModelIds: [] }));
  let response: { status: number; body: Uint8Array };
  try {
    response = await input.transport.unary({
      path: CURSOR_GET_USABLE_MODELS_PATH,
      headers: buildDiscoveryHeaders({ accessToken: input.accessToken }),
      body,
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      timeoutMs: input.timeoutMs ?? 15_000,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    if (input.signal?.aborted) throw input.signal.reason;
    throw new CursorCatalogError('Cursor model discovery network failure', true);
  }
  if (response.status === 401 || response.status === 403) {
    throw new CursorCatalogError('Cursor model discovery rejected', false, response.status);
  }
  if (response.status !== 200) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new CursorCatalogError('Cursor model discovery failed', retryable, response.status);
  }
  const framed = decodeConnectUnaryBody(response.body) ?? response.body;
  let models: readonly { modelId?: string; displayName?: string }[];
  try {
    models = fromBinary(GetUsableModelsResponseSchema, framed).models;
  } catch {
    throw new CursorCatalogError('Cursor model discovery returned invalid protobuf', true);
  }
  const language = dedupeById(models);
  if (language.length === 0) {
    throw new CursorCatalogError('Cursor model discovery returned no models', false, 200);
  }
  return { language, image: [], embedding: [], speech: [], transcription: [], reranking: [] };
}

export function initialCursorCatalogFallback(error: unknown): ModelCatalog | undefined {
  return error instanceof CursorCatalogError && error.retryable ? staticCursorCatalog() : undefined;
}

function dedupeById(
  models: readonly { modelId?: string; displayModelId?: string; displayName?: string; maxMode?: boolean }[],
): ModelDescriptor[] {
  const byId = new Map<string, ModelDescriptor>();
  for (const model of models) {
    const id = typeof model.modelId === 'string' ? model.modelId.trim() : '';
    if (id.length === 0 || byId.has(id)) continue;
    const displayModelId = model.displayModelId?.trim() || id;
    byId.set(id, {
      id,
      ...(model.displayName ? { displayName: model.displayName } : {}),
      metadata: { displayModelId, maxMode: model.maxMode ?? false },
    });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}
