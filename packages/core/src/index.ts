import type {
  Provider as ConfigProvider,
  ModelEntry,
  ProviderProtocol,
} from "@aio-proxy/types";
import type { AiSdkProviderInstance } from "./provider/ai-sdk";
import type { ApiProviderInstance } from "./provider/api";

export { type IngressError, toIngressError } from "./egress/error";
export {
  writeOpenAIChatCompletion,
  writeOpenAIChatSSE,
} from "./egress/openai-chat";
export {
  type AnthropicCacheControl,
  type AnthropicMessagesRequest,
  AnthropicMessagesRequestSchema,
  type AnthropicTextBlock,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  parseAnthropicMessages,
} from "./ingress/anthropic-messages";
export {
  type OpenAIChatRequest,
  OpenAIChatRequestSchema,
  parseOpenAIChat,
} from "./ingress/openai-chat";
export {
  AiSdkProviderError,
  type AiSdkProviderFactoryOptions,
  type AiSdkProviderInstance,
  createAiSdkProvider,
} from "./provider/ai-sdk";
export {
  type ApiProviderConfig,
  type ApiProviderFactoryOptions,
  type ApiProviderInstance,
  type ApiProviderTrace,
  type ApiProviderTraceSink,
  createApiProvider,
} from "./provider/api";
export {
  type AnthropicMessagesFromModelMessages,
  type AnthropicMessagesModelMessages,
  AnthropicMessagesTransformError,
  type AnthropicModelMessage,
  anthropicMessagesToModelMessages,
  modelMessagesToAnthropicMessages,
} from "./transform/anthropic-messages";
export {
  modelMessagesToOpenAIChat,
  type OpenAIChatFromModelMessages,
  type OpenAIChatModelMessages,
  OpenAIChatTransformError,
  type OpenAIChatTransformSettings,
  type OpenAIChatTransformTool,
  openaiChatToModelMessages,
} from "./transform/openai-chat";

export type ProviderSummary = {
  readonly id: string;
  readonly protocol: ProviderProtocol;
};

export type ProviderInstance =
  | (ConfigProvider & { readonly id: string })
  | ApiProviderInstance
  | AiSdkProviderInstance;

export type RouterResolution<
  TProvider extends ProviderInstance = ProviderInstance,
> = {
  readonly provider: TProvider;
  readonly modelId: string;
};

type ModelRoute = {
  readonly alias: string;
  readonly modelId: string;
};

export class RouterModelNotFoundError extends Error {
  readonly code = "MODEL_NOT_FOUND";
  readonly status = 404;

  constructor(readonly model: string) {
    super(`Model not found: ${model}`);
    this.name = "RouterModelNotFoundError";
  }
}

export class RouterModelCollisionError extends Error {
  constructor(
    readonly alias: string,
    readonly firstProviderId: string,
    readonly secondProviderId: string,
  ) {
    super(
      `Model alias "${alias}" is exposed by both "${firstProviderId}" and "${secondProviderId}"`,
    );
    this.name = "RouterModelCollisionError";
  }
}

export class Router<TProvider extends ProviderInstance = ProviderInstance> {
  private readonly aliases = new Map<string, RouterResolution<TProvider>>();
  private readonly providerAliases = new Map<
    string,
    RouterResolution<TProvider>
  >();

  constructor(providers: readonly TProvider[]) {
    for (const provider of providers) {
      for (const model of provider.models ?? []) {
        this.addRoute(provider, modelRoute(model));
      }
    }
  }

  resolve(model: string): RouterResolution<TProvider> {
    const route =
      model.indexOf("/") > 0
        ? this.providerAliases.get(model)
        : this.aliases.get(model);

    if (route === undefined) {
      throw new RouterModelNotFoundError(model);
    }

    return route;
  }

  private addRoute(provider: TProvider, model: ModelRoute): void {
    const route = { provider, modelId: model.modelId };
    const providerAlias = `${provider.id}/${model.alias}`;
    const existingProviderRoute = this.providerAliases.get(providerAlias);

    if (existingProviderRoute !== undefined) {
      throw new RouterModelCollisionError(
        model.alias,
        existingProviderRoute.provider.id,
        provider.id,
      );
    }

    const existingRoute = this.aliases.get(model.alias);
    if (
      existingRoute !== undefined &&
      existingRoute.provider.id !== provider.id
    ) {
      throw new RouterModelCollisionError(
        model.alias,
        existingRoute.provider.id,
        provider.id,
      );
    }

    this.providerAliases.set(providerAlias, route);
    this.aliases.set(model.alias, route);
  }
}

function modelRoute(model: ModelEntry): ModelRoute {
  if (typeof model === "string") {
    return { alias: model, modelId: model };
  }

  return { alias: model.alias, modelId: model.id };
}
