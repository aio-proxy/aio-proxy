import type { ApiProviderInstance } from "@aio-proxy/core";
import type { DashboardProviderProbe, Provider } from "@aio-proxy/types";

import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";

export type ProviderProbe = () => Promise<DashboardProviderProbe>;

const probeMaxOutputTokens = 1;
const openAIResponsesProbeMaxOutputTokens = 16;

export async function probeApi(
  provider: Extract<Provider, { kind: ProviderKind.Api }>,
  instance: ApiProviderInstance,
): Promise<DashboardProviderProbe> {
  try {
    const model = providerProbeModel(provider);
    if (model === undefined) {
      return "FAIL";
    }
    const request = providerProbeRequest(provider, model);
    const response = await instance.passthrough(
      new Request(request.url, {
        body: JSON.stringify(request.body),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(1_000),
      }),
    );
    if (response.body !== null) {
      await response.body.cancel();
    }
    return response.ok ? "OK" : "FAIL";
  } catch (error) {
    if (error instanceof Error) {
      return "FAIL";
    }
    throw error;
  }
}

export function providerProbeRequest(
  provider: Extract<Provider, { kind: ProviderKind.Api }>,
  model: string,
): { readonly body: unknown; readonly url: URL } {
  const url = new URL(provider.baseURL);
  switch (provider.protocol) {
    case ProviderProtocol.OpenAICompatible:
      url.pathname = "/v1/chat/completions";
      return {
        body: { max_tokens: probeMaxOutputTokens, messages: [{ role: "user", content: "ping" }], model },
        url,
      };
    case ProviderProtocol.OpenAIResponse:
      url.pathname = "/v1/responses";
      return { body: { input: "ping", max_output_tokens: openAIResponsesProbeMaxOutputTokens, model }, url };
    case ProviderProtocol.Anthropic:
      url.pathname = "/v1/messages";
      return {
        body: {
          max_tokens: probeMaxOutputTokens,
          messages: [{ role: "user", content: "ping" }],
          model,
        },
        url,
      };
    case ProviderProtocol.Gemini:
      url.pathname = `/v1beta/models/${model}:generateContent`;
      return {
        body: {
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: probeMaxOutputTokens },
        },
        url,
      };
    default:
      return assertNever(provider.protocol);
  }
}

export function providerProbeModel(provider: Extract<Provider, { kind: ProviderKind.Api }>): string | undefined {
  const aliasTarget = provider.alias === undefined ? undefined : Object.values(provider.alias)[0]?.model;
  return aliasTarget ?? provider.models?.[0];
}

export async function probeAiSdk(provider: {
  readonly ensureAvailable?: () => Promise<void>;
}): Promise<DashboardProviderProbe> {
  if (provider.ensureAvailable === undefined) {
    return "OK";
  }

  try {
    await provider.ensureAvailable();
    return "OK";
  } catch (error) {
    if (error instanceof Error) {
      return "FAIL";
    }
    throw error;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported provider: ${String(value)}`);
}
