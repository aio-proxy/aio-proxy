import {
  type AccountContext,
  CATALOG_DISCOVERY_TIMEOUT_MS,
  type JsonValue,
  type ModelCatalog,
  type ModelDescriptor,
  zod,
} from '@aio-proxy/plugin-sdk';

import { currentGoogleCredential } from '../oauth/refresh';
import { antigravityEndpoints } from '../runtime/endpoints';
import { antigravityUserAgent } from '../runtime/hub-version';
import type { GoogleAntigravityAccountOptions, GoogleAntigravityCredential } from '../schema';
import { collapseAntigravityFamilies, pickerModelIds } from './collapse';
import { CatalogDiscoveryError } from './errors';

const DISCOVERY_PATH = '/v1internal:fetchAvailableModels';
const DISCOVERY_ENDPOINT_TIMEOUT_MS = CATALOG_DISCOVERY_TIMEOUT_MS / 3;

export const ANTIGRAVITY_MODEL_DENYLIST = new Set([
  'chat_20706',
  'chat_23310',
  'tab_flash_lite_preview',
  'tab_jump_flash_lite_preview',
  'gemini-2.5-pro',
]);

const discoveredModelSchema = zod
  .object({
    displayName: zod.string().optional(),
    supportsImages: zod.boolean().optional(),
    supportsThinking: zod.boolean().optional(),
    thinkingBudget: zod.number().optional(),
    minThinkingBudget: zod.number().optional(),
    apiProvider: zod.string().optional(),
    modelProvider: zod.string().optional(),
    model: zod.string().optional(),
    maxTokens: zod.number().optional(),
    maxOutputTokens: zod.number().optional(),
    isInternal: zod.boolean().optional(),
    supportsVideo: zod.boolean().optional(),
  })
  .loose();

const agentModelGroupSchema = zod
  .object({
    displayName: zod.string().optional(),
    modelIds: zod.array(zod.string()).default([]),
  })
  .loose();

const agentModelSortSchema = zod
  .object({
    displayName: zod.string().optional(),
    groups: zod.array(agentModelGroupSchema).default([]),
  })
  .loose();

const tieredModelIdsSchema = zod
  .object({
    flash: zod.array(zod.string()).optional(),
    flashLite: zod.array(zod.string()).optional(),
    pro: zod.array(zod.string()).optional(),
  })
  .loose();

const deprecatedModelEntrySchema = zod.object({ newModelId: zod.string().optional() }).loose();

const discoverySchema = zod
  .object({
    models: zod.record(zod.string(), discoveredModelSchema),
    webSearchModelIds: zod.array(zod.string()).optional(),
    agentModelSorts: zod.array(agentModelSortSchema).optional(),
    tieredModelIds: tieredModelIdsSchema.optional(),
    deprecatedModelIds: zod.record(zod.string(), deprecatedModelEntrySchema).optional(),
  })
  .loose();

export type AntigravityPickerFields = {
  readonly agentModelSorts?: zod.infer<typeof discoverySchema>['agentModelSorts'];
  readonly tieredModelIds?: zod.infer<typeof discoverySchema>['tieredModelIds'];
  readonly deprecatedModelIds?: zod.infer<typeof discoverySchema>['deprecatedModelIds'];
};

export type DiscoveredAntigravityModel = zod.infer<typeof discoveredModelSchema>;

export type AntigravityDiscoveryDependencies = {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly timeoutSignal?: () => AbortSignal;
};

export async function discoverAntigravityCatalog(
  context: AccountContext<GoogleAntigravityCredential, GoogleAntigravityAccountOptions>,
  dependencies: AntigravityDiscoveryDependencies = {},
): Promise<ModelCatalog> {
  throwIfCallerAborted(context.signal);
  const credential = await currentGoogleCredential(context, {
    fetch: dependencies.fetch,
    now: dependencies.now,
    signal: context.signal,
  });
  throwIfCallerAborted(context.signal);
  const endpoints = antigravityEndpoints(context.options, 'discovery');
  let lastError: CatalogDiscoveryError | undefined;

  for (const endpoint of endpoints) {
    try {
      return await discoverEndpoint(endpoint, credential.value, context.signal, dependencies);
    } catch (error) {
      if (!(error instanceof CatalogDiscoveryError)) throw error;
      lastError = error;
      if (error.kind !== 'retryable') throw error;
    }
  }

  throw lastError ?? new CatalogDiscoveryError('retryable');
}

export function normalizeDiscoveredModels(
  models: Readonly<Record<string, DiscoveredAntigravityModel>>,
  webSearchModelIds: readonly string[] = [],
  deprecatedModelIds: ReadonlySet<string> | readonly string[] = [],
): ModelDescriptor[] {
  const webSearchIds = new Set(webSearchModelIds.map((id) => id.trim()).filter(Boolean));
  const deprecatedIds = deprecatedModelIds instanceof Set ? deprecatedModelIds : new Set(deprecatedModelIds);
  const descriptors = new Map<string, ModelDescriptor>();

  for (const [rawModelId, model] of Object.entries(models)) {
    const modelId = rawModelId.trim();
    if (
      modelId === '' ||
      model.isInternal === true ||
      ANTIGRAVITY_MODEL_DENYLIST.has(modelId) ||
      deprecatedIds.has(modelId)
    ) {
      continue;
    }
    const displayName = model.displayName?.trim();
    descriptors.set(modelId, {
      id: modelId,
      ...(displayName === undefined || displayName === '' ? {} : { displayName }),
      metadata: {
        antigravity: discoveredCapabilities(model, webSearchIds.has(modelId)),
      },
    });
  }

  return [...descriptors.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function discoverEndpoint(
  endpoint: string,
  credential: GoogleAntigravityCredential,
  callerSignal: AbortSignal,
  dependencies: AntigravityDiscoveryDependencies,
): Promise<ModelCatalog> {
  throwIfCallerAborted(callerSignal);
  const timeoutSignal = dependencies.timeoutSignal?.() ?? AbortSignal.timeout(DISCOVERY_ENDPOINT_TIMEOUT_MS);
  throwIfRequestAborted(callerSignal, timeoutSignal);
  let response: Response;
  try {
    response = await (dependencies.fetch ?? globalThis.fetch)(`${endpoint}${DISCOVERY_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': antigravityUserAgent(),
      },
      body: JSON.stringify({ project: credential.projectId }),
      signal: AbortSignal.any([callerSignal, timeoutSignal]),
    });
  } catch {
    throwIfRequestAborted(callerSignal, timeoutSignal);
    throw new CatalogDiscoveryError('retryable');
  }
  throwIfRequestAborted(callerSignal, timeoutSignal);

  if (!response.ok) throw classifyStatus(response.status);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throwIfRequestAborted(callerSignal, timeoutSignal);
    throw new CatalogDiscoveryError('retryable');
  }
  throwIfRequestAborted(callerSignal, timeoutSignal);
  const parsed = discoverySchema.safeParse(payload);
  if (!parsed.success) throw new CatalogDiscoveryError('retryable');
  const language = normalizeDiscoveredModels(
    parsed.data.models,
    parsed.data.webSearchModelIds,
    Object.keys(parsed.data.deprecatedModelIds ?? {}),
  );
  if (language.length === 0) throw new CatalogDiscoveryError('empty');
  return assembleAntigravityCatalog(language, {
    agentModelSorts: parsed.data.agentModelSorts,
    tieredModelIds: parsed.data.tieredModelIds,
    deprecatedModelIds: parsed.data.deprecatedModelIds,
  });
}

export function assembleAntigravityCatalog(
  language: readonly ModelDescriptor[],
  picker: AntigravityPickerFields = {},
): ModelCatalog {
  const languageIds = new Set(language.map((model) => model.id));
  const pickerIds = pickerModelIds({
    languageIds,
    tieredModelIds: picker.tieredModelIds,
    agentModelSorts: picker.agentModelSorts,
  });
  const descriptorsById = new Map(language.map((model) => [model.id, model]));
  return {
    language,
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
    metadata: {
      antigravityPicker: {
        ...(picker.agentModelSorts === undefined ? {} : { agentModelSorts: picker.agentModelSorts }),
        ...(picker.tieredModelIds === undefined ? {} : { tieredModelIds: picker.tieredModelIds }),
        ...(picker.deprecatedModelIds === undefined ? {} : { deprecatedModelIds: picker.deprecatedModelIds }),
      },
      antigravityFamilies: collapseAntigravityFamilies({
        pickerIds,
        descriptorsById,
        deprecatedModelIds: picker.deprecatedModelIds,
      }),
    } as JsonValue,
  };
}

function classifyStatus(status: number): CatalogDiscoveryError {
  if (status === 401 || status === 403) return new CatalogDiscoveryError('authorization', { status });
  if (status === 429 || (status >= 500 && status <= 599)) return new CatalogDiscoveryError('retryable', { status });
  return new CatalogDiscoveryError('request', { status });
}

function discoveredCapabilities(model: DiscoveredAntigravityModel, supportsWebSearch: boolean) {
  const maxOutputTokens = finitePositive(model.maxOutputTokens);
  const thinkingBudget = finiteNumber(model.thinkingBudget);
  const minThinkingBudget = finiteNumber(model.minThinkingBudget);
  const apiProvider = nonEmpty(model.apiProvider);
  const modelProvider = nonEmpty(model.modelProvider);
  const modelEnum = nonEmpty(model.model);
  return {
    supportsImages: model.supportsImages === true,
    supportsThinking: model.supportsThinking === true,
    supportsWebSearch,
    contextWindow: positive(model.maxTokens, 200_000),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(thinkingBudget === undefined ? {} : { thinkingBudget }),
    ...(minThinkingBudget === undefined ? {} : { minThinkingBudget }),
    ...(apiProvider === undefined ? {} : { apiProvider }),
    ...(modelProvider === undefined ? {} : { modelProvider }),
    ...(modelEnum === undefined ? {} : { modelEnum }),
  };
}

function throwIfRequestAborted(callerSignal: AbortSignal, timeoutSignal: AbortSignal): void {
  throwIfCallerAborted(callerSignal);
  if (timeoutSignal.aborted) throw new CatalogDiscoveryError('retryable');
}

function throwIfCallerAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason: unknown = signal.reason;
  throw reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function positive(value: number | undefined, fallback: number): number {
  return finitePositive(value) ?? fallback;
}

function finitePositive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}
