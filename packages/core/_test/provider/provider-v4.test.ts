import { describe, expect, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";
import { createProviderV4Invoke, validateProviderV4 } from "../../src/provider/provider-v4";

describe("validateProviderV4", () => {
  test("accepts the callable official OpenAI provider", () => {
    expect(validateProviderV4(createOpenAI({ apiKey: "test" }))).toBe(true);
  });

  test.each([
    {},
    { specificationVersion: "v3", languageModel() {}, imageModel() {}, embeddingModel() {} },
    { specificationVersion: "v4", languageModel() {}, imageModel() {} },
    {
      specificationVersion: "v4",
      languageModel() {},
      imageModel() {},
      embeddingModel() {},
      speechModel: true,
    },
  ])("rejects invalid provider shapes", (provider) => {
    expect(validateProviderV4(provider)).toBe(false);
  });
});

test("ProviderV4 invoke resolves the routed model through languageModel", () => {
  const calls: string[] = [];
  const provider = {
    specificationVersion: "v4",
    languageModel(modelId: string) {
      calls.push(modelId);
      return {
        specificationVersion: "v4",
        provider: "test",
        modelId,
        supportedUrls: {},
        doGenerate: async () => {
          throw new Error("unused");
        },
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 0, text: 0, reasoning: 0 },
                },
              });
              controller.close();
            },
          }),
        }),
      };
    },
    imageModel() {},
    embeddingModel() {},
  };
  const invoke = createProviderV4Invoke("openai", provider as never);

  const stream = invoke({ modelId: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
  expect(stream).toBeInstanceOf(ReadableStream);
  expect(calls).toEqual(["gpt-4o-mini"]);
  void stream.cancel();
});

test("ProviderV4 invoke injects logical context without overwriting provider options", async () => {
  let callOptions: Record<string, unknown> | undefined;
  const provider = {
    specificationVersion: "v4",
    languageModel(modelId: string) {
      return {
        specificationVersion: "v4",
        provider: "test",
        modelId,
        supportedUrls: {},
        doGenerate: async () => {
          throw new Error("unused");
        },
        doStream: async (options: unknown) => {
          callOptions = options as Record<string, unknown>;
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop", raw: "stop" },
                  usage: {
                    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 0, text: 0, reasoning: 0 },
                  },
                });
                controller.close();
              },
            }),
          };
        },
      };
    },
    imageModel() {},
    embeddingModel() {},
  };
  const context = {
    requestId: "01989e4a-8d23-7155-bff0-bb781836dd49",
    session: { key: `sha256:${"a".repeat(64)}` as const, source: "transcript" },
  } satisfies LogicalRequestContext;
  const invoke = createProviderV4Invoke("openai", provider as never);

  for await (const _part of invoke({
    context,
    messages: [{ role: "user", content: "hi" }],
    modelId: "gpt-4o-mini",
    settings: {
      providerOptions: {
        aioProxy: { existing: "keep" },
        google: { safetySettings: ["safe"] },
      },
    },
  })) {
  }

  expect(callOptions?.providerOptions).toEqual({
    aioProxy: { existing: "keep", logicalRequest: context },
    google: { safetySettings: ["safe"] },
  });
});
