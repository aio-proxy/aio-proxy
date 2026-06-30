import type { ModelEntry, Provider, ProviderProtocol } from "@aio-proxy/types";

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

export type ProviderInstance = Provider & {
  readonly id: string;
};

export type RouterResolution = {
  readonly provider: ProviderInstance;
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

export class Router {
  private readonly aliases = new Map<string, RouterResolution>();
  private readonly providerAliases = new Map<string, RouterResolution>();

  constructor(providers: readonly ProviderInstance[]) {
    for (const provider of providers) {
      for (const model of provider.models ?? []) {
        this.addRoute(provider, modelRoute(model));
      }
    }
  }

  resolve(model: string): RouterResolution {
    const route =
      model.indexOf("/") > 0
        ? this.providerAliases.get(model)
        : this.aliases.get(model);

    if (route === undefined) {
      throw new RouterModelNotFoundError(model);
    }

    return route;
  }

  private addRoute(provider: ProviderInstance, model: ModelRoute): void {
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
