import type { LogicalRequestContext, ProviderExecutedTool } from "@aio-proxy/plugin-sdk";
import type { AiSdkProvider, AliasConfig, ModelId, ProviderKind } from "@aio-proxy/types";

import type {
  AiSdkLanguageModel,
  CallSettings,
  LoadedAiSdkRuntimeProvider,
  ModelMessage,
  TextStreamPart,
  ToolSet,
} from "../../ai-sdk-bridge";
import type { AiSdkProviderLoadOptions } from "../ai-sdk-loader/index";
import type { ProviderFetch } from "../proxy-fetch";

import { streamAiSdkText } from "../../ai-sdk-bridge";
import { AiSdkProviderError, ProviderNotInstalledError } from "../../error";
import { loadAiSdkProvider } from "../ai-sdk-loader/index";
import { createAiSdkReasoningAdapter, parsesDeepSeekReasoning } from "../ai-sdk-reasoning";

type AiSdkProviderOptions = Readonly<Record<string, Readonly<Record<string, unknown>>>> & {
  readonly aioProxy?: Readonly<Record<string, unknown>>;
};

export type AiSdkProviderInvokeRequest = {
  readonly context: LogicalRequestContext;
  readonly modelId: string;
  readonly messages: readonly ModelMessage[];
  readonly settings?: CallSettings & { readonly providerOptions?: AiSdkProviderOptions };
  readonly tools?: ToolSet;
  readonly providerTools?: readonly ProviderExecutedTool[];
  readonly signal?: AbortSignal;
};

export type AiSdkProviderFactoryOptions = {
  readonly loadProvider?: (
    packageName: string,
    options?: AiSdkProviderLoadOptions,
  ) => Promise<LoadedAiSdkRuntimeProvider | null>;
  readonly resolveModel?: (
    config: AiSdkProvider,
    modelId: string,
    provider: LoadedAiSdkRuntimeProvider | null,
  ) => AiSdkLanguageModel | undefined;
  /** Injected by provider materialization to route upstream calls through the effective proxy. Wired in Tasks 5–6. */
  readonly fetch?: ProviderFetch;
};

export type AiSdkProviderInstance = {
  readonly enabled: boolean;
  readonly id: string;
  readonly kind: ProviderKind.AiSdk;
  readonly models?: readonly ModelId[];
  readonly alias?: Readonly<Record<string, AliasConfig>>;
  readonly ensureAvailable?: () => Promise<void>;
  readonly invoke: (request: AiSdkProviderInvokeRequest) => ReadableStream<TextStreamPart<ToolSet>>;
};

type LanguageModelShape = {
  readonly provider?: unknown;
  readonly modelId?: unknown;
  readonly doStream?: unknown;
};

export function createAiSdkProvider(
  config: AiSdkProvider,
  options: AiSdkProviderFactoryOptions = {},
): AiSdkProviderInstance {
  const loadProvider = options.loadProvider ?? loadAiSdkProvider;
  let loadedProviderTask: Promise<LoadedAiSdkRuntimeProvider | null> | undefined;

  function providerTask(): Promise<LoadedAiSdkRuntimeProvider | null> {
    loadedProviderTask ??= loadProvider(config.packageName, loadOptions(config, options.fetch));
    return loadedProviderTask;
  }

  return {
    enabled: config.enabled,
    id: config.id,
    kind: config.kind,
    ...(config.models === undefined ? {} : { models: config.models }),
    ...(config.alias === undefined ? {} : { alias: config.alias }),
    async ensureAvailable() {
      try {
        if ((await providerTask()) === null) {
          throw new ProviderNotInstalledError(config.id, config.packageName);
        }
      } catch (error) {
        if (error instanceof ProviderNotInstalledError) {
          throw error;
        }

        throw new AiSdkProviderError(config.id, error);
      }
    },
    invoke(request) {
      return new ReadableStream({
        async start(controller) {
          try {
            if (request.providerTools !== undefined && request.providerTools.length > 0) {
              throw new TypeError("AI SDK providers do not support provider-executed tools");
            }
            const model =
              options.resolveModel?.(config, request.modelId, null) ??
              (await resolveProviderModel(config, request.modelId, providerTask, options.resolveModel));
            const result = streamAiSdkText({
              model,
              messages: request.messages,
              ...(request.settings === undefined ? {} : { settings: request.settings }),
              ...(request.tools === undefined ? {} : { tools: request.tools }),
              ...(request.signal === undefined ? {} : { signal: request.signal }),
              includeRawChunks: parsesDeepSeekReasoning(config, request.modelId),
            });
            const reasoningAdapter = createAiSdkReasoningAdapter(config, request.modelId);

            for await (const part of result.fullStream) {
              enqueueStreamParts(controller, reasoningAdapter.push(part));
            }

            for (const emitted of reasoningAdapter.flush()) {
              controller.enqueue(emitted);
            }

            controller.close();
          } catch (error) {
            if (error instanceof ProviderNotInstalledError) {
              controller.error(error);
              return;
            }

            controller.error(new AiSdkProviderError(config.id, error));
          }
        },
      });
    },
  };
}

async function resolveProviderModel(
  config: AiSdkProvider,
  modelId: string,
  providerTask: () => Promise<LoadedAiSdkRuntimeProvider | null>,
  resolveModel: AiSdkProviderFactoryOptions["resolveModel"],
): Promise<AiSdkLanguageModel> {
  const provider = await providerTask();
  return resolveModel?.(config, modelId, provider) ?? (await resolveLoadedModel({ config, modelId, provider }));
}

function enqueueStreamParts(
  controller: ReadableStreamDefaultController<TextStreamPart<ToolSet>>,
  parts: readonly TextStreamPart<ToolSet>[],
): void {
  for (const part of parts) {
    if (part.type === "error") {
      throw part.error;
    }
    controller.enqueue(part);
  }
}

function loadOptions(config: AiSdkProvider, providerFetch: ProviderFetch | undefined): AiSdkProviderLoadOptions {
  const configured = config.options ?? {};
  const options = providerFetch === undefined ? configured : { ...configured, fetch: providerFetch };
  if (config.packageName !== "@ai-sdk/openai-compatible" || options["name"] !== undefined) return options;
  return { ...options, name: config.id };
}

async function resolveLoadedModel({
  config,
  modelId,
  provider,
}: {
  readonly config: AiSdkProvider;
  readonly modelId: string;
  readonly provider: LoadedAiSdkRuntimeProvider | null;
}): Promise<AiSdkLanguageModel> {
  if (provider === null) {
    throw new ProviderNotInstalledError(config.id, config.packageName);
  }

  const callableModel = callableProviderModel(provider, modelId);
  if (callableModel !== undefined) {
    return callableModel;
  }

  if (typeof provider !== "function" && typeof provider.languageModel === "function") {
    return provider.languageModel(modelId);
  }

  throw new AiSdkProviderError(
    config.id,
    `ai-sdk provider "${config.packageName}" does not expose a language model resolver`,
  );
}

function callableProviderModel(provider: LoadedAiSdkRuntimeProvider, modelId: string): AiSdkLanguageModel | undefined {
  if (typeof provider !== "function") {
    return undefined;
  }

  const model: unknown = provider(modelId);
  return isLanguageModel(model) ? model : undefined;
}

function isLanguageModel(value: unknown): value is AiSdkLanguageModel {
  if (!isRecord(value)) {
    return false;
  }

  const candidate: LanguageModelShape = value;

  return (
    typeof candidate.provider === "string" &&
    typeof candidate.modelId === "string" &&
    typeof candidate.doStream === "function"
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
