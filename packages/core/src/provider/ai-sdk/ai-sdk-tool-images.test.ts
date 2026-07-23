import type { ProviderV3 } from "@ai-sdk/provider";

import { expect, test } from "bun:test";

import type { AiSdkProviderLoadOptions } from "../../index";

import { createAiSdkProvider } from "../../index";

const availableProvider = {
  languageModel() {
    throw new Error("languageModel should not be called by ensureAvailable");
  },
} satisfies Pick<ProviderV3, "languageModel">;

test("configured compatible provider rewrites marked tool images", async () => {
  let optionsSeen: AiSdkProviderLoadOptions | undefined;
  let upstreamRequest: Request | undefined;
  const provider = createAiSdkProvider(
    {
      kind: "ai-sdk",
      id: "compatible",
      packageName: "@ai-sdk/openai-compatible",
      options: { apiKey: "test", baseURL: "https://upstream.test/v1" },
    },
    {
      fetch: async (input, init) => {
        upstreamRequest = new Request(input, init);
        return Response.json({ ok: true });
      },
      async loadProvider(_packageName, options) {
        optionsSeen = options;
        return availableProvider;
      },
    },
  );
  await provider.ensureAvailable?.();

  const sdkBody = {
    model: "gpt-test",
    messages: [
      {
        role: "tool",
        tool_call_id: "call_1",
        content: JSON.stringify([
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: "AA==" },
            providerOptions: { aioProxy: { toolImage: true } },
          },
        ]),
      },
    ],
  };

  const modelFetch = optionsSeen?.fetch;
  if (typeof modelFetch !== "function") throw new Error("compatible model fetch was not installed");
  await modelFetch("https://upstream.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sdkBody),
  });

  expect(await upstreamRequest?.json()).toEqual({
    model: "gpt-test",
    messages: [
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }],
      },
    ],
  });
});
