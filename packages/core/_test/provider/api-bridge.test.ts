import { describe, expect, test } from "bun:test";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import type {
  AiSdkProviderLoadOptions,
  LanguageModelV2,
  LoadedAiSdkProvider,
  ModelMessage,
  TextStreamPart,
  ToolSet,
} from "../../src/index";
import { bridgeApiProviderToAiSdk, createApiProvider } from "../../src/index";

declare const process: {
  readonly env: Record<string, string | undefined>;
};

const messages: readonly ModelMessage[] = [{ role: "user", content: "hello" }];

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

async function collect(stream: ReadableStream<TextStreamPart<ToolSet>>): Promise<readonly TextStreamPart<ToolSet>[]> {
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

function model(modelId: string, text: string): LanguageModelV2 {
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

function loadedProvider(factory: LoadedProviderFactory): LoadedAiSdkProvider {
  return Object.assign((modelId: string) => factory.languageModel(modelId), {
    languageModel: factory.languageModel,
    ...(factory.responses === undefined ? {} : { responses: factory.responses }),
  });
}

describe("bridgeApiProviderToAiSdk", () => {
  test("Given api provider protocols When bridged Then package and options are forwarded", async () => {
    // Given
    const previousKey = process.env.AIO_PROXY_BRIDGE_KEY;
    process.env.AIO_PROXY_BRIDGE_KEY = "env-bridge-secret";
    const cases = [
      {
        protocol: ProviderProtocol.OpenAICompatible,
        packageName: "@ai-sdk/openai-compatible",
        options: {
          apiKey: "env-bridge-secret",
          baseURL: "https://api.example.com/v1",
          name: "provider-openai-compatible",
        },
      },
      {
        protocol: ProviderProtocol.Anthropic,
        packageName: "@ai-sdk/anthropic",
        options: {
          apiKey: "env-bridge-secret",
          baseURL: "https://api.example.com/v1",
        },
      },
      {
        protocol: ProviderProtocol.Gemini,
        packageName: "@ai-sdk/google",
        options: {
          apiKey: "env-bridge-secret",
          baseURL: "https://api.example.com/v1",
        },
      },
      {
        protocol: ProviderProtocol.OpenAIResponse,
        packageName: "@ai-sdk/openai",
        options: {
          apiKey: "env-bridge-secret",
          baseURL: "https://api.example.com/v1",
        },
      },
    ] as const;

    try {
      for (const expected of cases) {
        let packageSeen: string | undefined;
        let optionsSeen: AiSdkProviderLoadOptions | undefined;
        const bridge = bridgeApiProviderToAiSdk(
          {
            kind: ProviderKind.Api,
            id: `provider-${expected.protocol}`,
            protocol: expected.protocol,
            apiKey: "$AIO_PROXY_BRIDGE_KEY",
            baseUrl: "https://api.example.com/v1",
            models: ["gpt-test"],
          },
          {
            async loadProvider(packageName, options) {
              packageSeen = packageName;
              optionsSeen = options;
              return loadedProvider({
                languageModel: (modelId) => model(modelId, "ok"),
              });
            },
          },
        );

        // When
        await bridge?.ensureAvailable?.();

        // Then
        expect(bridge?.id).toBe(`provider-${expected.protocol}:bridge`);
        expect(bridge?.kind).toBe(ProviderKind.AiSdk);
        expect(bridge?.models).toEqual(["gpt-test"]);
        expect(packageSeen).toBe(expected.packageName);
        expect(optionsSeen).toEqual(expected.options);
      }
    } finally {
      if (previousKey === undefined) {
        delete process.env.AIO_PROXY_BRIDGE_KEY;
      } else {
        process.env.AIO_PROXY_BRIDGE_KEY = previousKey;
      }
    }
  });

  test("Given OpenAI Responses bridge When provider exposes responses Then responses model is preferred", async () => {
    // Given
    let responsesSeen: string | undefined;
    let languageSeen: string | undefined;
    const bridge = bridgeApiProviderToAiSdk(
      {
        kind: ProviderKind.Api,
        id: "responses",
        protocol: ProviderProtocol.OpenAIResponse,
        baseUrl: "https://api.example.com/v1",
        models: ["gpt-test"],
      },
      {
        async loadProvider() {
          return loadedProvider({
            languageModel(modelId) {
              languageSeen = modelId;
              return model(modelId, "language");
            },
            responses(modelId) {
              responsesSeen = modelId;
              return model(modelId, "responses");
            },
          });
        },
      },
    );

    // When
    const parts = bridge === undefined ? [] : await collect(bridge.invoke({ messages, modelId: "gpt-test" }));

    // Then
    expect(responsesSeen).toBe("gpt-test");
    expect(languageSeen).toBeUndefined();
    expect(parts.filter((part) => part.type === "text-delta")).toEqual([
      { type: "text-delta", id: "text-1", text: "responses" },
    ]);
  });

  test("Given OpenAI Responses bridge without responses resolver When invoked Then languageModel is used", async () => {
    // Given
    let languageSeen: string | undefined;
    const bridge = bridgeApiProviderToAiSdk(
      {
        kind: ProviderKind.Api,
        id: "responses",
        protocol: ProviderProtocol.OpenAIResponse,
        baseUrl: "https://api.example.com/v1",
        models: ["gpt-test"],
      },
      {
        async loadProvider() {
          return loadedProvider({
            languageModel(modelId) {
              languageSeen = modelId;
              return model(modelId, "language");
            },
          });
        },
      },
    );

    // When
    const parts = bridge === undefined ? [] : await collect(bridge.invoke({ messages, modelId: "gpt-test" }));

    // Then
    expect(languageSeen).toBe("gpt-test");
    expect(parts.filter((part) => part.type === "text-delta")).toEqual([
      { type: "text-delta", id: "text-1", text: "language" },
    ]);
  });

  test("Given materialized api provider When bridged Then retained metadata is used", async () => {
    // Given
    let packageSeen: string | undefined;
    let optionsSeen: AiSdkProviderLoadOptions | undefined;
    const provider = createApiProvider({
      kind: ProviderKind.Api,
      id: "responses",
      protocol: ProviderProtocol.OpenAIResponse,
      apiKey: "secret",
      baseUrl: "https://api.example.com/v1",
      models: ["gpt-test"],
    });

    const bridge = bridgeApiProviderToAiSdk(provider, {
      async loadProvider(packageName, options) {
        packageSeen = packageName;
        optionsSeen = options;
        return loadedProvider({ languageModel: (modelId) => model(modelId, "ok") });
      },
    });

    // When
    await bridge?.ensureAvailable?.();

    // Then
    expect(packageSeen).toBe("@ai-sdk/openai");
    expect(optionsSeen).toEqual({
      apiKey: "secret",
      baseURL: "https://api.example.com/v1",
    });
  });
});
