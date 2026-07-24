import { createToolImageMarker } from "@aio-proxy/plugin-sdk/openai-stream";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { expect, test } from "bun:test";

import type { AiSdkProviderLoadOptions } from "../../index";

import { bridgeApiProviderToAiSdk } from "../../index";
import { loadedProvider, model } from "./api-bridge-test-helpers";

test("compatible API bridge rewrites marked tool images", async () => {
  let optionsSeen: AiSdkProviderLoadOptions | undefined;
  let upstreamRequest: Request | undefined;
  const bridge = bridgeApiProviderToAiSdk(
    {
      kind: ProviderKind.Api,
      id: "compatible-api",
      protocol: ProviderProtocol.OpenAICompatible,
      apiKey: "test",
      baseURL: "https://upstream.test/v1",
      models: ["gpt-test"],
    },
    {
      fetch: async (input, init) => {
        upstreamRequest = new Request(input, init);
        return Response.json({ ok: true });
      },
      async loadProvider(_packageName, options) {
        optionsSeen = options;
        return loadedProvider({ languageModel: (modelId) => model(modelId, "ok") });
      },
    },
  );
  await bridge?.ensureAvailable?.();

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
            providerOptions: { aioProxy: createToolImageMarker() },
          },
        ]),
      },
    ],
  };
  const modelFetch = optionsSeen?.fetch;
  if (typeof modelFetch !== "function") throw new Error("bridge model fetch was not installed");
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
