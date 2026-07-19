import type { OAuthRuntimeResult, ProtocolId, RuntimeContext } from "@aio-proxy/plugin-sdk";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { kimiIdentityHeaders } from "./headers";
import { currentKimiCredential, type KimiCredential, type KimiOAuthDependencies } from "./oauth";

type KimiProtocol = Extract<ProtocolId, "openai-compatible" | "anthropic">;

const PLACEHOLDER = "dynamic-credential";

export async function createKimiRuntime(
  context: RuntimeContext<KimiCredential, Record<string, never>>,
  dependencies: KimiOAuthDependencies = {},
): Promise<OAuthRuntimeResult> {
  const dynamicFetch = createKimiDynamicFetch(context.credentials, dependencies);
  const openai = createOpenAICompatible({
    name: "kimi-code.openai-compatible",
    baseURL: "https://api.kimi.com/coding/v1",
    apiKey: PLACEHOLDER,
    fetch: dynamicFetch,
  });
  const anthropic = createAnthropic({
    name: "kimi-code.anthropic",
    baseURL: "https://api.kimi.com/coding/v1",
    authToken: PLACEHOLDER,
    fetch: dynamicFetch,
  });
  const protocols = new Map(
    context.catalog.language.flatMap((model) => {
      const protocol = catalogProtocol(model.metadata);
      return protocol === undefined ? [] : [[model.id, protocol] as const];
    }),
  );
  const modelIds = new Set(context.catalog.language.map((model) => model.id));

  return {
    provider: {
      specificationVersion: "v4",
      languageModel(modelId) {
        const protocol = protocols.get(modelId);
        if (protocol === "anthropic") return anthropic.languageModel(modelId);
        if (protocol === "openai-compatible") return openai.languageModel(modelId);
        throw new Error(`Kimi Code model ${modelId} has no supported protocol metadata`);
      },
      embeddingModel: (modelId) => openai.embeddingModel(modelId),
      imageModel: (modelId) => openai.imageModel(modelId),
    },
    raw(input) {
      if (!modelIds.has(input.modelId)) return undefined;
      const protocol =
        input.protocol === "anthropic" || input.protocol === "openai-compatible" ? input.protocol : undefined;
      if (protocol === undefined) return undefined;
      return {
        invoke: async (request) => dynamicFetch(rewriteRawRequest(request, protocol)),
      };
    },
    tokenCount: {
      async countTokens(input) {
        if (input.protocol !== "anthropic") {
          throw new Error(`Kimi token count does not support ${input.protocol}`);
        }
        const body: unknown = await input.request.json();
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          throw new Error("Kimi token count request is invalid");
        }
        const response = await dynamicFetch("https://api.kimi.com/coding/v1/messages/count_tokens?beta=true", {
          method: "POST",
          headers: input.request.headers,
          body: JSON.stringify({ ...body, model: input.modelId }),
          signal: input.request.signal,
        });
        if (!response.ok) throw new Error(`Kimi token count request failed with ${response.status}`);
        const result: unknown = await response.json();
        const inputTokens =
          typeof result === "object" && result !== null ? Reflect.get(result, "input_tokens") : undefined;
        if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) {
          throw new Error("Kimi token count response is invalid");
        }
        return { inputTokens };
      },
    },
  };
}

export function createKimiDynamicFetch(
  credentials: RuntimeContext<KimiCredential, Record<string, never>>["credentials"],
  dependencies: KimiOAuthDependencies = {},
) {
  const fetchWithCredential = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const credential = await currentKimiCredential(credentials, { ...dependencies, signal: request.signal });
    const headers = new Headers(request.headers);
    for (const key of [
      "authorization",
      "proxy-authorization",
      "cookie",
      "host",
      "x-api-key",
      "x-goog-api-key",
      "anthropic-api-key",
    ]) {
      headers.delete(key);
    }
    headers.set("authorization", `Bearer ${credential.accessToken}`);
    for (const [key, value] of Object.entries(kimiIdentityHeaders(credential.deviceId))) headers.set(key, value);
    return await (dependencies.fetch ?? globalThis.fetch)(request.url, {
      method: request.method,
      headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }),
      signal: request.signal,
      redirect: request.redirect,
    });
  };
  return Object.assign(fetchWithCredential, { preconnect: globalThis.fetch.preconnect });
}

function rewriteRawRequest(request: Request, protocol: KimiProtocol): Request {
  const source = new URL(request.url);
  const expectedPath = protocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  if (source.pathname !== expectedPath) throw new Error("Unsupported Kimi raw path");
  const target = new URL(`https://api.kimi.com/coding${expectedPath}`);
  target.search = source.search;
  return new Request(target, request);
}

function catalogProtocol(metadata: unknown): KimiProtocol | undefined {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined;
  const value = Reflect.get(metadata, "protocol");
  return value === "anthropic" || value === "openai-compatible" ? value : undefined;
}
