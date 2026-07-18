import { afterEach, describe, expect, test } from "bun:test";
import type { AiSdkProviderInstance } from "@aio-proxy/core";
import type { ModelMessage } from "ai";
import { createTempHomes, textStream } from "../../_test/openai-responses.test-support";
import { createServer } from "../server";

const homes = createTempHomes("aio-proxy-responses-model-");
afterEach(homes.cleanup);

describe("OpenAI Responses model HTTP integration", () => {
  test("converts developer and parallel function history for a model-only provider", async () => {
    let messagesSeen: readonly ModelMessage[] | undefined;
    const provider = {
      id: "model",
      kind: "ai-sdk",
      models: ["gpt-5.6-terra"],
      alias: { "gpt-5.6-terra": { model: "gpt-5.6-terra", preserve: false } },
      invoke(request) {
        messagesSeen = request.messages;
        return textStream([
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: {},
          },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      dbHome: homes.tempHome(),
      providerInstances: [provider],
    });

    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-terra",
        stream: false,
        input: [
          { role: "developer", content: "Use tools carefully." },
          { role: "user", content: "Read both files." },
          { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a"}' },
          { type: "function_call", call_id: "call_2", name: "read_file", arguments: '{"path":"b"}' },
          { type: "function_call_output", call_id: "call_1", output: "A" },
          { type: "function_call_output", call_id: "call_2", output: "B" },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(messagesSeen).toEqual([
      {
        role: "system",
        content: "Use tools carefully.",
        providerOptions: {
          aioProxy: {
            openaiResponses: {
              protocol: "openai-responses",
              inputIndex: 0,
              itemType: "message",
              wireRole: "developer",
            },
          },
        },
      },
      { role: "user", content: "Read both files." },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call_1", toolName: "read_file", input: { path: "a" } },
          { type: "tool-call", toolCallId: "call_2", toolName: "read_file", input: { path: "b" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "read_file",
            output: { type: "text", value: "A" },
          },
          {
            type: "tool-result",
            toolCallId: "call_2",
            toolName: "read_file",
            output: { type: "text", value: "B" },
          },
        ],
      },
    ]);
  });
});
