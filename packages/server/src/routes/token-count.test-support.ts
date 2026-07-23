import type { TokenCountCapability } from "@aio-proxy/plugin-sdk";

import {
  anthropicMessagesAdapter,
  geminiGenerateContentAdapter,
  openAIResponsesAdapter,
  Router,
} from "@aio-proxy/core";
import { ConfigSchema, ProviderKind, type ProviderProtocol } from "@aio-proxy/types";

import type { ProviderRouteSource, RuntimeProviderInstance } from "../runtime";

import { createRecording } from "../../_test/pipeline-helpers/recording";
import { LogicalSessionStore } from "../logical-session-store";
import { handleTokenCount } from "./token-count";

export const requestedModel = "count-model";

export function countFixture(providers: readonly RuntimeProviderInstance[]) {
  const router = new Router(providers);
  const recording = createRecording();
  let releaseCount = 0;
  const source = {
    acquireProviderSnapshot: () => ({
      snapshot: { providers, router },
      release: () => {
        releaseCount += 1;
      },
    }),
    currentProviderSnapshot: () => ({ providers, router }),
    logicalSessionStore: new LogicalSessionStore(),
    requestRecorder: recording.recorder,
    usageCapture: {
      passthrough(): never {
        throw new Error("token counting must not capture generation usage");
      },
      stream(): never {
        throw new Error("token counting must not capture generation usage");
      },
    },
  } satisfies ProviderRouteSource;
  return {
    recording,
    releases: () => releaseCount,
    source,
    anthropic: (request = anthropicRequest()) =>
      handleTokenCount({
        adapter: anthropicMessagesAdapter,
        context: {},
        format: (inputTokens) => ({ input_tokens: inputTokens }),
        rawRequest: request,
        source,
      }),
    gemini: (request = geminiRequest()) =>
      handleTokenCount({
        adapter: geminiGenerateContentAdapter,
        context: geminiContext(),
        format: (inputTokens) => ({ totalTokens: inputTokens }),
        rawRequest: request,
        source,
      }),
    openAIResponses: (request = openAIResponsesRequest()) =>
      handleTokenCount({
        adapter: openAIResponsesAdapter,
        context: {},
        format: (inputTokens) => ({ input_tokens: inputTokens }),
        rawRequest: request,
        source,
      }),
  };
}

export function provider(options: {
  readonly id: string;
  readonly supportsProviderTool?: boolean;
  readonly targetProtocol?: ProviderProtocol;
  readonly tokenCount?: TokenCountCapability["countTokens"];
}): RuntimeProviderInstance {
  return {
    alias: { [requestedModel]: { model: `${options.id}-wire`, preserve: false } },
    enabled: true,
    id: options.id,
    kind: ProviderKind.OAuth,
    model: {
      invoke() {
        throw new Error("generation must not run during token counting");
      },
      supportsProviderTool: () => options.supportsProviderTool === true,
      ...(options.targetProtocol === undefined ? {} : { targetProtocol: () => options.targetProtocol }),
    },
    ...(options.tokenCount === undefined ? {} : { tokenCount: { countTokens: options.tokenCount } }),
  };
}

export function configOrderedProviders(
  entries: readonly { readonly provider: RuntimeProviderInstance; readonly weight: number }[],
): readonly RuntimeProviderInstance[] {
  const config = ConfigSchema.parse({
    providers: Object.fromEntries(
      entries.map(({ provider, weight }) => [
        provider.id,
        { kind: "ai-sdk", models: [requestedModel], packageName: "@example/provider", weight },
      ]),
    ),
  });
  const byId = new Map(entries.map(({ provider }) => [provider.id, provider]));
  return config.providers.map(({ id }) => byId.get(id) as RuntimeProviderInstance);
}

export function counter(id: string, inputTokens: number, calls: string[]): TokenCountCapability["countTokens"] {
  return async () => {
    calls.push(id);
    return { inputTokens };
  };
}

export function anthropicRequest(overrides: Readonly<Record<string, unknown>> = {}): Request {
  return jsonRequest("https://proxy.test/v1/messages/count_tokens", {
    model: requestedModel,
    max_tokens: 16,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  });
}

export function geminiRequest(): Request {
  return jsonRequest(`https://proxy.test/v1beta/models/${requestedModel}:countTokens`, {
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
  });
}

export function openAIResponsesRequest(): Request {
  return jsonRequest("https://proxy.test/v1/responses/input_tokens", {
    model: requestedModel,
    input: [
      { type: "custom_tool_call", call_id: "call_1", name: "exec", input: "pwd" },
      { type: "custom_tool_call_output", call_id: "call_1", output: "done" },
    ],
    tools: [{ type: "custom", name: "exec", description: "shell", format: { type: "text" } }],
  });
}

export function geminiContext() {
  return { model: requestedModel, stream: false };
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
