import { geminiGenerateContentAdapter, openAIResponsesAdapter } from "@aio-proxy/core";
import { ProviderProtocol } from "@aio-proxy/types";
import { expect, test } from "bun:test";

import { handleProtocolRequest } from ".";
import {
  defineProviderRouteSource,
  errorStream,
  modelProvider,
  REQUESTED_MODEL,
  settleRecording,
  textStream,
} from "../../../_test/pipeline-helpers";

test("target materialization does not pollute a later fallback candidate", async () => {
  const responses = modelProvider({
    id: "responses",
    targetProtocol: ProviderProtocol.OpenAIResponse,
    invoke: () => errorStream(new Error("responses unavailable")),
  });
  const anthropic = modelProvider({
    id: "anthropic",
    targetProtocol: ProviderProtocol.Anthropic,
    invoke: () => textStream("fallback response"),
  });
  const route = defineProviderRouteSource([responses, anthropic]);
  const rawRequest = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: REQUESTED_MODEL,
      input: [
        { type: "custom_tool_call", call_id: "call_1", name: "exec", input: "pwd" },
        { type: "custom_tool_call_output", call_id: "call_1", output: "done" },
      ],
      tools: [{ type: "custom", name: "exec", description: "shell", format: { type: "text" } }],
    }),
  });

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest,
    source: route.source,
  });
  await settleRecording();

  expect(response.status).toBe(200);
  expect(responses.calls.model).toHaveLength(1);
  expect(responses.calls.model[0]?.tools?.exec).toMatchObject({ type: "provider" });
  expect(responses.calls.model[0]?.messages[0]).toMatchObject({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "call_1", toolName: "exec", input: "pwd" }],
  });
  expect(anthropic.calls.model).toHaveLength(1);
  expect(anthropic.calls.model[0]?.tools?.exec).toMatchObject({ type: "function" });
  expect(anthropic.calls.model[0]?.messages[0]).toMatchObject({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "call_1", toolName: "exec", input: { input: "pwd" } }],
  });
});

test("image detail skips targets that cannot preserve it", async () => {
  const anthropic = modelProvider({
    id: "anthropic",
    targetProtocol: ProviderProtocol.Anthropic,
    invoke: () => textStream("must not run"),
  });
  const responses = modelProvider({
    id: "responses",
    targetProtocol: ProviderProtocol.OpenAIResponse,
    invoke: () => textStream("fallback response"),
  });
  const route = defineProviderRouteSource([anthropic, responses]);
  const rawRequest = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: REQUESTED_MODEL,
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" }],
        },
      ],
    }),
  });

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest,
    source: route.source,
  });
  await settleRecording();

  expect(response.status).toBe(200);
  expect(anthropic.calls.model).toHaveLength(0);
  expect(responses.calls.model).toHaveLength(1);
  expect(responses.calls.model[0]?.messages[0]).toMatchObject({
    role: "user",
    content: [
      {
        type: "file",
        mediaType: "image/png",
        data: { type: "data", data: "AA==" },
        providerOptions: { openai: { imageDetail: "low" } },
      },
    ],
  });
});

test("Gemini model-history images skip incompatible targets and preserve Gemini fileData", async () => {
  const anthropic = modelProvider({
    id: "anthropic",
    targetProtocol: ProviderProtocol.Anthropic,
    invoke: () => textStream("must not run"),
  });
  const gemini = modelProvider({
    id: "gemini",
    targetProtocol: ProviderProtocol.Gemini,
    invoke: () => textStream("fallback response"),
  });
  const route = defineProviderRouteSource([anthropic, gemini]);
  const rawRequest = new Request(`https://proxy.test/v1beta/models/${REQUESTED_MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "model",
          parts: [
            { inlineData: { mimeType: "image/png", data: "AA==" } },
            { fileData: { mimeType: "image/png", fileUri: "https://example.test/prior.png" } },
          ],
        },
      ],
    }),
  });

  const response = await handleProtocolRequest({
    adapter: geminiGenerateContentAdapter,
    context: { model: REQUESTED_MODEL, stream: false },
    rawRequest,
    source: route.source,
  });
  await settleRecording();

  expect(response.status).toBe(200);
  expect(anthropic.calls.model).toHaveLength(0);
  expect(gemini.calls.model).toHaveLength(1);
  expect(gemini.calls.model[0]?.messages[0]).toEqual({
    role: "assistant",
    content: [
      { type: "file", mediaType: "image/png", data: { type: "data", data: "AA==" } },
      {
        type: "file",
        mediaType: "image/png",
        data: { type: "reference", reference: { google: "https://example.test/prior.png" } },
      },
    ],
  });
});
