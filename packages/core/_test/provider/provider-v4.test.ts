import { describe, expect, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
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
