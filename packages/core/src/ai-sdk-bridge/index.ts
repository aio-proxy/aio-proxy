import type {
  LanguageModelV2,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV3,
  LanguageModelV4,
  ProviderV3,
  ProviderV4,
} from "@ai-sdk/provider";
import type {
  AsyncIterableStream,
  CallSettings,
  FilePart,
  JSONValue,
  ModelMessage,
  TextPart,
  TextStreamPart,
  ToolSet,
} from "ai";
import { jsonSchema, streamText } from "ai";

export type {
  AsyncIterableStream,
  CallSettings,
  FilePart,
  JSONValue,
  LanguageModelV2,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV3,
  LanguageModelV4,
  ModelMessage,
  ProviderV3,
  ProviderV4,
  TextPart,
  TextStreamPart,
  ToolSet,
};
export { jsonSchema };

export type AiSdkLanguageModel = LanguageModelV2 | LanguageModelV3 | LanguageModelV4;

export type AiSdkRuntimeProvider = ProviderV3 | ProviderV4;
export type AiSdkCallableProvider = (modelId: string) => AiSdkLanguageModel;

export type LoadedAiSdkRuntimeProvider = AiSdkRuntimeProvider | AiSdkCallableProvider;

export type AiSdkTextStreamRequest = {
  readonly model: AiSdkLanguageModel;
  readonly messages: readonly ModelMessage[];
  readonly settings?: CallSettings;
  readonly tools?: ToolSet;
  readonly signal?: AbortSignal;
  readonly includeRawChunks?: boolean;
};

export type AiSdkTextStreamResult = {
  readonly fullStream: AsyncIterableStream<TextStreamPart<ToolSet>>;
};

export function streamAiSdkText({
  includeRawChunks,
  messages,
  model,
  settings = {},
  signal,
  tools,
}: AiSdkTextStreamRequest): AiSdkTextStreamResult {
  return streamText({
    ...settings,
    model,
    messages: [...messages],
    ...(tools === undefined ? {} : { tools }),
    ...(signal === undefined ? {} : { abortSignal: signal }),
    ...(includeRawChunks === true ? { includeRawChunks: true } : {}),
  });
}
