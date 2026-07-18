import {
  type AccountContext,
  CATALOG_DISCOVERY_TIMEOUT_MS,
  type ModelCatalog,
  type ModelDescriptor,
  zod,
} from "@aio-proxy/plugin-sdk";
import { currentGoogleCredential } from "../oauth/refresh";
import { antigravityEndpoints } from "../runtime/endpoints";
import { antigravityUserAgent } from "../runtime/hub-version";
import type { GoogleAntigravityAccountOptions, GoogleAntigravityCredential } from "../schema";
import { CatalogDiscoveryError } from "./errors";
import { ANTIGRAVITY_RETIRED_MODEL_IDS } from "./families";

const DISCOVERY_PATH = "/v1internal:fetchAvailableModels";
const DISCOVERY_ENDPOINT_TIMEOUT_MS = CATALOG_DISCOVERY_TIMEOUT_MS / 3;

export const ANTIGRAVITY_MODEL_DENYLIST = new Set([
  "chat_20706",
  "chat_23310",
  "tab_flash_lite_preview",
  "tab_jump_flash_lite_preview",
  "gemini-2.5-pro",
]);

const discoveredModelSchema = zod
  .object({
    displayName: zod.string().optional(),
    supportsImages: zod.boolean().optional(),
    supportsThinking: zod.boolean().optional(),
    thinkingBudget: zod.number().optional(),
    maxTokens: zod.number().optional(),
    maxOutputTokens: zod.number().optional(),
    isInternal: zod.boolean().optional(),
    supportsVideo: zod.boolean().optional(),
  })
  .loose();

const discoverySchema = zod
  .object({
    models: zod.record(zod.string(), discoveredModelSchema),
    webSearchModelIds: zod.array(zod.string()).optional(),
  })
  .loose();

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
  const endpoints = antigravityEndpoints(context.options, "discovery");
  let lastError: CatalogDiscoveryError | undefined;

  for (const endpoint of endpoints) {
    try {
      return await discoverEndpoint(endpoint, credential.value, context.signal, dependencies);
    } catch (error) {
      if (!(error instanceof CatalogDiscoveryError)) throw error;
      lastError = error;
      if (error.kind !== "retryable") throw error;
    }
  }

  throw lastError ?? new CatalogDiscoveryError("retryable");
}

export function normalizeDiscoveredModels(
  models: Readonly<Record<string, DiscoveredAntigravityModel>>,
  webSearchModelIds: readonly string[] = [],
): ModelDescriptor[] {
  const webSearchIds = new Set(webSearchModelIds.map((id) => id.trim()).filter(Boolean));
  const descriptors = new Map<string, ModelDescriptor>();

  for (const [rawModelId, model] of Object.entries(models)) {
    const modelId = rawModelId.trim();
    if (
      modelId === "" ||
      model.isInternal === true ||
      ANTIGRAVITY_MODEL_DENYLIST.has(modelId) ||
      ANTIGRAVITY_RETIRED_MODEL_IDS.has(modelId)
    ) {
      continue;
    }
    const displayName = model.displayName?.trim();
    descriptors.set(modelId, {
      id: modelId,
      ...(displayName === undefined || displayName === "" ? {} : { displayName }),
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
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": antigravityUserAgent(),
      },
      body: JSON.stringify({ project: credential.projectId }),
      signal: AbortSignal.any([callerSignal, timeoutSignal]),
    });
  } catch {
    throwIfRequestAborted(callerSignal, timeoutSignal);
    throw new CatalogDiscoveryError("retryable");
  }
  throwIfRequestAborted(callerSignal, timeoutSignal);

  if (!response.ok) throw classifyStatus(response.status);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throwIfRequestAborted(callerSignal, timeoutSignal);
    throw new CatalogDiscoveryError("retryable");
  }
  throwIfRequestAborted(callerSignal, timeoutSignal);
  const parsed = discoverySchema.safeParse(payload);
  if (!parsed.success) throw new CatalogDiscoveryError("retryable");
  const language = normalizeDiscoveredModels(parsed.data.models, parsed.data.webSearchModelIds);
  if (language.length === 0) throw new CatalogDiscoveryError("empty");
  return { language, image: [], embedding: [], speech: [], transcription: [], reranking: [] };
}

function classifyStatus(status: number): CatalogDiscoveryError {
  if (status === 401 || status === 403) return new CatalogDiscoveryError("authorization", { status });
  if (status === 429 || (status >= 500 && status <= 599)) return new CatalogDiscoveryError("retryable", { status });
  return new CatalogDiscoveryError("request", { status });
}

function discoveredCapabilities(model: DiscoveredAntigravityModel, supportsWebSearch: boolean) {
  return {
    supportsImages: model.supportsImages === true,
    supportsThinking: model.supportsThinking === true,
    supportsWebSearch,
    contextWindow: positive(model.maxTokens, 200_000),
    maxOutputTokens: positive(model.maxOutputTokens, 64_000),
  };
}

function throwIfRequestAborted(callerSignal: AbortSignal, timeoutSignal: AbortSignal): void {
  throwIfCallerAborted(callerSignal);
  if (timeoutSignal.aborted) throw new CatalogDiscoveryError("retryable");
}

function throwIfCallerAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason: unknown = signal.reason;
  throw reason ?? new DOMException("The operation was aborted", "AbortError");
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
