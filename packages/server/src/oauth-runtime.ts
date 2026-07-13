import { createAiSdkProvider } from "@aio-proxy/core";
import { type CopilotTransport, githubCopilotOAuthProvider } from "@aio-proxy/oauth";
import type { OAuthProvider } from "@aio-proxy/types";
import { OAuthVendor, ProviderKind, ProviderProtocol } from "@aio-proxy/types";

import { createOpenAIChatGPTRuntimeProvider as createOpenAIChatGPTRuntimeProviderImpl } from "./oauth-chatgpt-runtime";

export { codexFetchWrapper, createOpenAIChatGPTRuntimeProvider } from "./oauth-chatgpt-runtime";

import { deriveOAuthAlias } from "./oauth-alias";
import type { OAuthProviderInstance } from "./runtime";

export function createOAuthRuntimeProvider(config: OAuthProvider): OAuthProviderInstance {
  switch (config.vendor) {
    case OAuthVendor.GitHubCopilot:
      return createGitHubCopilotRuntimeProvider(config);
    case OAuthVendor.OpenAIChatGPT:
      return createOpenAIChatGPTRuntimeProviderImpl(config);
    default:
      return assertNever(config.vendor);
  }
}

export function createGitHubCopilotRuntimeProvider(config: OAuthProvider): OAuthProviderInstance {
  const payload = githubCopilotOAuthProvider.payload(config.id) as {
    access?: unknown;
    baseUrl?: unknown;
    models?: unknown;
  } | null;
  const cachedModels = cachedCopilotModels(payload?.models);
  const transportByModelId = new Map(cachedModels?.map(({ id, transport }) => [id, transport]) ?? []);
  const modelIds = cachedModels?.map((model) => model.id) ?? [];
  if (cachedModels === undefined && payload !== null) {
    console.warn(
      `${config.id}: no cached Copilot model list — run \`aio-proxy provider login copilot\` to sync; only config alias routes are exposed`,
    );
  }
  const derivedAlias = deriveOAuthAlias(modelIds, config.alias);
  const access = typeof payload?.access === "string" ? payload.access : undefined;
  const baseUrl = typeof payload?.baseUrl === "string" ? payload.baseUrl : undefined;
  const providers = {
    [ProviderProtocol.OpenAICompatible]: createAiSdkProvider(
      aiConfig(config, "@ai-sdk/openai-compatible", {
        apiKey: access,
        baseURL: baseUrl,
        headers: copilotHeaders(),
        name: config.id,
      }),
    ),
    [ProviderProtocol.Anthropic]: createAiSdkProvider(
      aiConfig(config, "@ai-sdk/anthropic", {
        apiKey: access,
        baseURL: baseUrl === undefined ? undefined : `${baseUrl}/v1`,
        headers: copilotHeaders(),
      }),
    ),
    [ProviderProtocol.OpenAIResponse]: createAiSdkProvider(
      aiConfig(config, "@ai-sdk/openai", {
        apiKey: access,
        baseURL: baseUrl,
        headers: copilotHeaders(),
      }),
    ),
  } as const;

  return {
    enabled: config.enabled,
    id: config.id,
    kind: ProviderKind.OAuth,
    models: modelIds,
    modelMetadata: Object.fromEntries(
      (cachedModels ?? []).map(({ id, displayName }) => [id, displayName === undefined ? {} : { displayName }]),
    ),
    alias: derivedAlias,
    vendor: config.vendor,
    async ensureAvailable() {
      if (access === undefined || baseUrl === undefined) {
        throw new Error(`${config.id}: GitHub Copilot login required`);
      }
      if (modelIds.length === 0) {
        throw new Error(`${config.id}: no model list cached — re-login to sync model routing`);
      }
    },
    invoke(request) {
      return providers[transportFor(transportByModelId, request.modelId)].invoke(request);
    },
  };
}

type CachedCopilotModel = {
  readonly id: string;
  readonly displayName?: string;
  readonly transport: CopilotTransport;
};

function cachedCopilotModels(value: unknown): CachedCopilotModel[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((model): CachedCopilotModel[] => {
    if (typeof model !== "object" || model === null) {
      return [];
    }
    const candidate = model as Partial<CachedCopilotModel>;
    if (
      typeof candidate.id !== "string" ||
      (candidate.transport !== ProviderProtocol.OpenAICompatible &&
        candidate.transport !== ProviderProtocol.Anthropic &&
        candidate.transport !== ProviderProtocol.OpenAIResponse)
    ) {
      return [];
    }
    return [
      {
        id: candidate.id,
        transport: candidate.transport,
        ...(typeof candidate.displayName === "string" ? { displayName: candidate.displayName } : {}),
      },
    ];
  });
}

function aiConfig(
  config: OAuthProvider,
  packageName: "@ai-sdk/openai-compatible" | "@ai-sdk/anthropic" | "@ai-sdk/openai",
  options: Record<string, unknown>,
) {
  return {
    enabled: config.enabled,
    id: config.id,
    kind: ProviderKind.AiSdk,
    packageName,
    options,
  } as const;
}

function transportFor(transportByModelId: ReadonlyMap<string, CopilotTransport>, modelId: string): CopilotTransport {
  return transportByModelId.get(modelId) ?? ProviderProtocol.OpenAICompatible;
}

function copilotHeaders(): Record<string, string> {
  return {
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Editor-Version": "vscode/1.107.0",
    "User-Agent": "GitHubCopilotChat/0.35.0",
  };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported OAuth vendor: ${String(value)}`);
}
