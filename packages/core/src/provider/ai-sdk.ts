import type { AiSdkProvider, ModelEntry, ProviderKind } from "@aio-proxy/types";
import type {
  AiSdkLanguageModel,
  CallSettings,
  LoadedAiSdkRuntimeProvider,
  ModelMessage,
  TextStreamPart,
  ToolSet,
} from "../ai-sdk-bridge";
import { streamAiSdkText } from "../ai-sdk-bridge";
import { AiSdkProviderError, ProviderNotInstalledError } from "../error";
import { type AiSdkProviderLoadOptions, loadAiSdkProvider } from "./ai-sdk-loader";
import { createAiSdkReasoningAdapter, parsesDeepSeekReasoning } from "./ai-sdk-reasoning";

export type AiSdkProviderInvokeRequest = {
  readonly modelId: string;
  readonly messages: readonly ModelMessage[];
  readonly settings?: CallSettings;
  readonly tools?: ToolSet;
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
};

export type AiSdkProviderInstance = {
  readonly id: string;
  readonly kind: ProviderKind.AiSdk;
  readonly models?: readonly ModelEntry[];
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
    loadedProviderTask ??= loadProvider(config.packageName, loadOptions(config));
    return loadedProviderTask;
  }

  return {
    id: config.id,
    kind: config.kind,
    ...(config.models === undefined ? {} : { models: config.models }),
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

function loadOptions(config: AiSdkProvider): AiSdkProviderLoadOptions {
  return config.options ?? {};
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
