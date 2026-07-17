import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { OAuthRuntimeResult, ProtocolId, RuntimeContext } from "@aio-proxy/plugin-sdk";
import {
  copilotHeaders,
  currentGitHubCopilotCredential,
  type GitHubAccountOptions,
  type GitHubCopilotCredential,
} from "./github-api";

const PLACEHOLDER_BASE_URL = "https://api.githubcopilot.com";
const PLACEHOLDER_CREDENTIAL = "dynamic-credential";

export async function createGitHubCopilotRuntime(
  context: RuntimeContext<GitHubCopilotCredential, GitHubAccountOptions>,
): Promise<OAuthRuntimeResult> {
  const dynamicFetch = createDynamicFetch(context.credentials);
  const openAICompatible = createOpenAICompatible({
    name: "github-copilot.openai-compatible",
    baseURL: PLACEHOLDER_BASE_URL,
    apiKey: PLACEHOLDER_CREDENTIAL,
    fetch: dynamicFetch,
  });
  const anthropic = createAnthropic({
    name: "github-copilot.anthropic",
    baseURL: `${PLACEHOLDER_BASE_URL}/v1`,
    authToken: PLACEHOLDER_CREDENTIAL,
    fetch: dynamicFetch,
  });
  const openAI = createOpenAI({
    name: "github-copilot.openai",
    baseURL: PLACEHOLDER_BASE_URL,
    apiKey: PLACEHOLDER_CREDENTIAL,
    fetch: dynamicFetch,
  });
  const protocolByModelId = new Map(
    context.catalog.language.flatMap((model) => {
      const protocol = catalogProtocol(model.metadata);
      return protocol === undefined ? [] : [[model.id, protocol] as const];
    }),
  );

  const provider = {
    specificationVersion: "v4" as const,
    languageModel(modelId: string) {
      const protocol = protocolByModelId.get(modelId);
      switch (protocol) {
        case "openai-compatible":
          return openAICompatible.languageModel(modelId);
        case "anthropic":
          return anthropic.languageModel(modelId);
        case "openai-response":
          return openAI.languageModel(modelId);
        default:
          throw new Error(`GitHub Copilot model ${modelId} has no supported protocol metadata`);
      }
    },
    embeddingModel(modelId: string) {
      return openAICompatible.embeddingModel(modelId);
    },
    imageModel(modelId: string) {
      return openAICompatible.imageModel(modelId);
    },
  } satisfies OAuthRuntimeResult["provider"];

  return {
    provider,
    raw(input) {
      if (protocolByModelId.get(input.modelId) !== input.protocol) return undefined;
      return {
        invoke: async (request) => {
          const credential = await currentGitHubCopilotCredential(context.credentials);
          return await fetchWithCredential(request, undefined, credential);
        },
      };
    },
  };
}

function createDynamicFetch(
  credentials: RuntimeContext<GitHubCopilotCredential, GitHubAccountOptions>["credentials"],
): typeof fetch {
  return async (input, init) => {
    const credential = await currentGitHubCopilotCredential(credentials);
    return await fetchWithCredential(input, init, credential);
  };
}

async function fetchWithCredential(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  credential: GitHubCopilotCredential,
): Promise<Response> {
  const request = new Request(input, init);
  const target = new URL(request.url);
  const baseURL = new URL(credential.baseURL);
  target.protocol = baseURL.protocol;
  target.host = baseURL.host;
  const headers = new Headers(request.headers);
  headers.delete("x-api-key");
  for (const [key, value] of Object.entries(copilotHeaders(credential.copilotToken))) headers.set(key, value);

  return await fetch(target, {
    method: request.method,
    headers,
    ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }),
    signal: init?.signal ?? (input instanceof Request ? input.signal : request.signal),
    redirect: request.redirect,
  });
}

function catalogProtocol(metadata: unknown): ProtocolId | undefined {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined;
  const protocol = Reflect.get(metadata, "protocol");
  return protocol === "openai-compatible" || protocol === "anthropic" || protocol === "openai-response"
    ? protocol
    : undefined;
}
