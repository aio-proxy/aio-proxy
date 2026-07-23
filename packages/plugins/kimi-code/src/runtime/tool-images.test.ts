import type { CredentialPort, ModelCatalog } from "@aio-proxy/plugin-sdk";

import { createToolImageMarker } from "@aio-proxy/plugin-sdk/openai-stream";
import { expect, test } from "bun:test";

import type { KimiCredential } from "../oauth";

import { createKimiRuntime } from "./runtime";

const toolImagePrompt = [
  {
    role: "assistant" as const,
    content: [{ type: "tool-call" as const, toolCallId: "call_1", toolName: "inspect", input: {} }],
  },
  {
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolCallId: "call_1",
        toolName: "inspect",
        output: {
          type: "content" as const,
          value: [
            { type: "text" as const, text: "before" },
            {
              type: "file" as const,
              mediaType: "image/png",
              data: { type: "data" as const, data: "AA==" },
              providerOptions: {
                openai: { imageDetail: "low" },
                aioProxy: createToolImageMarker(),
              },
            },
          ],
        },
      },
    ],
  },
] as const;

test("compatible delegate emits CPA tool image content", async () => {
  let captured: Request | undefined;
  const runtime = await createKimiRuntime(context(validCredential(), catalog()), {
    fetch: async (input, init) => {
      captured = new Request(input, init);
      return Response.json({
        id: "chatcmpl-test",
        created: 1,
        model: "openai-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });

  await runtime.provider.languageModel("openai-model").doGenerate({ prompt: toolImagePrompt });

  expect((await captured?.json()) as unknown).toMatchObject({
    messages: [
      expect.objectContaining({ role: "assistant" }),
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [
          { type: "text", text: "before" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "low" } },
        ],
      },
    ],
  });
});

function validCredential(): KimiCredential {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: 4_000_000_000_000,
    deviceId: "device-1",
  };
}

function credentialPort(initial: KimiCredential): CredentialPort<KimiCredential> {
  return {
    read: async () => ({ value: initial, revision: 1 }),
    refresh: async () => {
      throw new Error("tool image test must not refresh credentials");
    },
  };
}

function catalog(): ModelCatalog {
  return {
    language: [{ id: "openai-model", metadata: { protocol: "openai-compatible" } }],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
}

function context(credential: KimiCredential, modelCatalog: ModelCatalog) {
  return { credentials: credentialPort(credential), options: {}, catalog: modelCatalog };
}
