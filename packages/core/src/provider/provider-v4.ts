import type { ProviderV4 } from "@ai-sdk/provider";
import { streamAiSdkText } from "../ai-sdk-bridge";
import { AiSdkProviderError } from "../error";
import type { AiSdkProviderInstance } from "./ai-sdk";

const required = ["languageModel", "imageModel", "embeddingModel"] as const;
const optional = ["speechModel", "transcriptionModel", "rerankingModel", "files", "skills"] as const;

export function validateProviderV4(value: unknown): value is ProviderV4 {
  const valueType = typeof value;
  if ((valueType !== "object" && valueType !== "function") || value === null) {
    return false;
  }
  const candidate = value as object;
  if (Reflect.get(candidate, "specificationVersion") !== "v4") return false;
  return (
    required.every((name) => typeof Reflect.get(candidate, name) === "function") &&
    optional.every((name) => {
      const method = Reflect.get(candidate, name);
      return method === undefined || typeof method === "function";
    })
  );
}

export function createProviderV4Invoke(providerId: string, provider: ProviderV4): AiSdkProviderInstance["invoke"] {
  return (request) => {
    const settings = {
      ...request.settings,
      providerOptions: {
        ...request.settings?.providerOptions,
        aioProxy: {
          ...(request.settings?.providerOptions?.aioProxy as Record<string, unknown> | undefined),
          logicalRequest: request.context,
          ...(request.providerTools === undefined || request.providerTools.length === 0
            ? {}
            : { providerTools: request.providerTools }),
        },
      },
    };
    return new ReadableStream({
      async start(controller) {
        try {
          const result = streamAiSdkText({
            model: provider.languageModel(request.modelId),
            messages: request.messages,
            settings,
            ...(request.tools === undefined ? {} : { tools: request.tools }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          });
          for await (const part of result.fullStream) {
            if (part.type === "error") throw part.error;
            controller.enqueue(part);
          }
          controller.close();
        } catch (error) {
          controller.error(new AiSdkProviderError(providerId, error));
        }
      },
    });
  };
}
