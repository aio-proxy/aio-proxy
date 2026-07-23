import { createOpenAI } from "@ai-sdk/openai";
import { expect, test } from "bun:test";

import { parseGeminiGenerateContent } from "../../ingress/gemini-generate-content";
import { geminiGenerateContentToModelMessages } from "./gemini-generate-content";
import { modelMessagesToGeminiGenerateContent } from "./gemini-generate-content-from-model";

test("preserves canonical function IDs when converting to Gemini", () => {
  const request = modelMessagesToGeminiGenerateContent({
    model: "gemini-3-flash-preview",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_1", toolName: "inspect", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "inspect",
            output: { type: "text", value: '{"ok":true}' },
          },
        ],
      },
    ],
    settings: {},
  });

  expect(request.contents).toEqual([
    {
      role: "model",
      parts: [{ functionCall: { id: "call_1", name: "inspect", args: {} } }],
    },
    {
      role: "user",
      parts: [{ functionResponse: { id: "call_1", name: "inspect", response: { ok: true } } }],
    },
  ]);
});

test("preserves official Gemini function IDs through the OpenAI Responses wire", async () => {
  const body = await openAIResponsesBody({
    model: "gemini-3-flash-preview",
    contents: [
      {
        role: "model",
        parts: [{ functionCall: { id: "call_1", name: "inspect", args: {} } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { id: "call_1", name: "inspect", response: { ok: true } } }],
      },
    ],
  });

  expect(body).toMatchObject({
    input: [
      { type: "function_call", call_id: "call_1", name: "inspect" },
      { type: "function_call_output", call_id: "call_1" },
    ],
  });
});

test("associates legacy ID-less function responses with same-name calls", async () => {
  const body = await openAIResponsesBody({
    model: "gemini-3-flash-preview",
    contents: [
      {
        role: "model",
        parts: [{ functionCall: { name: "inspect", args: {} } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "inspect", response: { ok: true } } }],
      },
    ],
  });

  expect(body).toMatchObject({
    input: [
      { type: "function_call", call_id: "gemini-0-0", name: "inspect" },
      { type: "function_call_output", call_id: "gemini-0-0" },
    ],
  });
});

async function openAIResponsesBody(input: unknown): Promise<unknown> {
  const request = parseGeminiGenerateContent(input);
  const converted = geminiGenerateContentToModelMessages(request);
  let body: unknown;
  const model = createOpenAI({
    apiKey: "test",
    fetch: (async (_request, init) => {
      body = JSON.parse(String(init?.body));
      throw new Error("request captured");
    }) as typeof globalThis.fetch,
  }).responses("gpt-5.6-sol");

  await expect(model.doGenerate({ prompt: converted.messages })).rejects.toThrow();
  if (body === undefined) throw new Error("provider did not issue a request");
  return body;
}
