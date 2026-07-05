import { createAiSdkProvider } from "@aio-proxy/core";
import { Auth } from "@aio-proxy/oauth";
import type { OAuthProvider } from "@aio-proxy/types";
import { ProviderKind } from "@aio-proxy/types";
import type { OAuthProviderInstance } from "./runtime";

type CopilotTransport = "chat" | "messages" | "responses";

export function createGitHubCopilotRuntimeProvider(config: OAuthProvider): OAuthProviderInstance {
  const row = Auth.get(config.vendor, config.id);
  const payload = row?.payload as {
    access?: unknown;
    baseUrl?: unknown;
    models?: unknown;
  } | null;
  const cachedModels = cachedCopilotModels(payload?.models);
  const modelEntries =
    cachedModels === undefined ? config.models : cachedModels.map(({ alias, id }) => ({ alias, id }));
  const transportByModelId = new Map(cachedModels?.map(({ id, transport }) => [id, transport]) ?? []);
  const access = typeof payload?.access === "string" ? payload.access : undefined;
  const baseUrl = typeof payload?.baseUrl === "string" ? payload.baseUrl : undefined;
  const providers = {
    chat: createAiSdkProvider(
      aiConfig(config, "@ai-sdk/openai-compatible", {
        apiKey: access,
        baseURL: baseUrl,
        headers: copilotHeaders(),
        name: config.id,
      }),
    ),
    messages: createAiSdkProvider(
      aiConfig(config, "@ai-sdk/anthropic", {
        apiKey: access,
        baseURL: baseUrl === undefined ? undefined : `${baseUrl}/v1`,
        headers: copilotHeaders(),
      }),
    ),
    responses: createAiSdkProvider(
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
    ...(modelEntries === undefined ? {} : { models: modelEntries }),
    vendor: config.vendor,
    async ensureAvailable() {
      if (access === undefined || baseUrl === undefined) {
        throw new Error(`${config.id}: GitHub Copilot login required`);
      }
    },
    invoke(request) {
      return providers[transportFor(transportByModelId, request.modelId)].invoke(request);
    },
  };
}

type CachedCopilotModel = {
  readonly alias: string;
  readonly id: string;
  readonly transport: CopilotTransport;
};

function cachedCopilotModels(value: unknown): CachedCopilotModel[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((model): model is CachedCopilotModel => {
    if (typeof model !== "object" || model === null) {
      return false;
    }
    const candidate = model as Partial<CachedCopilotModel>;
    return (
      typeof candidate.alias === "string" &&
      typeof candidate.id === "string" &&
      (candidate.transport === "chat" || candidate.transport === "messages" || candidate.transport === "responses")
    );
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
  return transportByModelId.get(modelId) ?? "chat";
}

function copilotHeaders(): Record<string, string> {
  return {
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Editor-Version": "vscode/1.107.0",
    "User-Agent": "GitHubCopilotChat/0.35.0",
  };
}
