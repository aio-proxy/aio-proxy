import type { LanguageModelV2, LanguageModelV3 } from "@ai-sdk/provider";
import type { AiSdkProvider, ModelEntry } from "@aio-proxy/types";
import type { CallSettings, ModelMessage, TextStreamPart, ToolSet } from "ai";
import { streamText } from "ai";

type AiSdkLanguageModel = LanguageModelV2 | LanguageModelV3;

export type AiSdkProviderFactoryOptions = {
  readonly resolveModel?: (config: AiSdkProvider) => AiSdkLanguageModel;
};

export type AiSdkProviderInstance = {
  readonly id: string;
  readonly kind: "ai-sdk";
  readonly models?: readonly ModelEntry[];
  readonly invoke: (
    messages: readonly ModelMessage[],
    settings?: CallSettings,
    tools?: ToolSet,
    signal?: AbortSignal,
  ) => ReadableStream<TextStreamPart<ToolSet>>;
};

export class AiSdkProviderError extends Error {
  override readonly name = "AiSdkProviderError";

  constructor(
    readonly providerId: string,
    cause: unknown,
  ) {
    super(`${providerId}: ${errorMessage(cause)}`, { cause });
  }
}

export function createAiSdkProvider(
  config: AiSdkProvider,
  options: AiSdkProviderFactoryOptions = {},
): AiSdkProviderInstance {
  const resolveModel = options.resolveModel ?? defaultResolveModel;

  return {
    id: config.id,
    kind: config.kind,
    ...(config.models === undefined ? {} : { models: config.models }),
    invoke(messages, settings = {}, tools, signal) {
      return new ReadableStream({
        async start(controller) {
          try {
            const result = streamText({
              model: resolveModel(config),
              messages: [...messages],
              ...(tools === undefined ? {} : { tools }),
              ...(signal === undefined ? {} : { abortSignal: signal }),
              ...settings,
            });

            for await (const part of result.fullStream) {
              if (part.type === "error") {
                throw part.error;
              }

              controller.enqueue(part);
            }

            controller.close();
          } catch (error) {
            controller.error(new AiSdkProviderError(config.id, error));
          }
        },
      });
    },
  };
}

function defaultResolveModel(config: AiSdkProvider): AiSdkLanguageModel {
  throw new AiSdkProviderError(
    config.id,
    `Bundled ai-sdk resolver is not implemented for ${config.packageName}`,
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
