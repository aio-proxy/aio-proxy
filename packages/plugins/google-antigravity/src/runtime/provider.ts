import type { LanguageModelV4, ProviderV4 } from "@ai-sdk/provider";
import type { JsonValue, OAuthRuntimeResult, RuntimeContext } from "@aio-proxy/plugin-sdk";

import type { GoogleAntigravityAccountOptions, GoogleAntigravityCredential } from "../schema";

import { createAntigravityCredentialSource } from "./credential";
import { type AntigravityLanguageModelRuntime, createAntigravityLanguageModel } from "./google-model";
import { takeAioProxyOptions } from "./private-options";
import { createGeminiRawResolver } from "./raw";
import { createAntigravityTokenCount } from "./token-count";
import { AntigravityTransport } from "./transport";

export type GoogleAntigravityRuntimeDependencies = {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

export function createAntigravityProviderV4(
  runtime: AntigravityLanguageModelRuntime,
  options: { readonly modelMetadata?: (modelId: string) => JsonValue | undefined } = {},
): ProviderV4 {
  return {
    specificationVersion: "v4",
    languageModel: (modelId) => providerLanguageModel(modelId, runtime, options.modelMetadata),
    embeddingModel: unsupported("embedding"),
    imageModel: unsupported("image generation"),
  };
}

export function createGoogleAntigravityRuntime(
  context: RuntimeContext<GoogleAntigravityCredential, GoogleAntigravityAccountOptions>,
  dependencies: GoogleAntigravityRuntimeDependencies = {},
): OAuthRuntimeResult {
  const credentials = createAntigravityCredentialSource(context.credentials, {
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  const transport = new AntigravityTransport({
    credentials,
    options: context.options,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
  });
  const modelRuntime: AntigravityLanguageModelRuntime = {
    call: (logicalRequest) => ({
      context: logicalRequest,
      transport,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    }),
  };
  const metadataByModel = new Map(context.catalog.language.map((descriptor) => [descriptor.id, descriptor.metadata]));
  return {
    provider: createAntigravityProviderV4(modelRuntime, {
      modelMetadata: (modelId) => metadataByModel.get(modelId),
    }),
    providerTools: { supported: ["web-search"] },
    raw: createGeminiRawResolver(transport),
    tokenCount: createAntigravityTokenCount(transport, (modelId) => metadataByModel.get(modelId)),
  };
}

function providerLanguageModel(
  modelId: string,
  runtime: AntigravityLanguageModelRuntime,
  modelMetadata: ((modelId: string) => JsonValue | undefined) | undefined,
): LanguageModelV4 {
  const shape = createAntigravityLanguageModel(modelId, runtime);
  const modelFor = (providerOptions: Parameters<LanguageModelV4["doGenerate"]>[0]["providerOptions"]) => {
    const providerTools = takeAioProxyOptions(providerOptions).privateOptions.providerTools;
    if (providerTools === undefined || providerTools.length === 0) return shape;
    const metadata = modelMetadata?.(modelId);
    return createAntigravityLanguageModel(modelId, {
      call: (context) => ({
        ...runtime.call(context),
        providerTools,
        ...(metadata === undefined ? {} : { modelMetadata: metadata }),
      }),
    });
  };
  return {
    ...shape,
    doGenerate: async (options) => await modelFor(options.providerOptions).doGenerate(options),
    doStream: async (options) => await modelFor(options.providerOptions).doStream(options),
  };
}

function unsupported(kind: string): (modelId: string) => never {
  return (modelId) => {
    throw new Error(`Google Antigravity does not support ${kind} model ${modelId}`);
  };
}
