import type { LanguageModelV2, LoadedAiSdkProvider, ModelMessage, TextStreamPart, ToolSet } from "../../index";

export const messages: readonly ModelMessage[] = [{ role: "user", content: "hello" }];

type LoadedProviderFactory = {
  readonly languageModel: (modelId: string) => LanguageModelV2;
  readonly responses?: (modelId: string) => LanguageModelV2;
};

type ModelStreamPart =
  | { readonly type: "text-start"; readonly id: string }
  | {
      readonly type: "text-delta";
      readonly id: string;
      readonly delta: string;
    }
  | { readonly type: "text-end"; readonly id: string };

export async function collect(
  stream: ReadableStream<TextStreamPart<ToolSet>>,
): Promise<readonly TextStreamPart<ToolSet>[]> {
  const parts: TextStreamPart<ToolSet>[] = [];
  for await (const part of stream) {
    parts.push(part);
  }

  return parts;
}

function textPartStream(text: string): ReadableStream<ModelStreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "text-1" });
      controller.enqueue({ type: "text-delta", id: "text-1", delta: text });
      controller.enqueue({ type: "text-end", id: "text-1" });
      controller.close();
    },
  });
}

export function model(modelId: string, text: string): LanguageModelV2 {
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId,
    supportedUrls: {},
    async doGenerate() {
      throw new Error("doGenerate should not be called");
    },
    async doStream() {
      return { stream: textPartStream(text) };
    },
  };
}

export function loadedProvider(factory: LoadedProviderFactory): LoadedAiSdkProvider {
  return Object.assign((modelId: string) => factory.languageModel(modelId), {
    languageModel: factory.languageModel,
    ...(factory.responses === undefined ? {} : { responses: factory.responses }),
  });
}
