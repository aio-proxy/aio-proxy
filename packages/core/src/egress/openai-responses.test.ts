import { describe, expect, test } from "bun:test";
import {
  aiSdkPartStream,
  frames,
  partStream,
  writeOpenAIResponsesResponse,
  writeOpenAIResponsesSSE,
} from "./openai-responses-test-support";

describe("OpenAI Responses egress", () => {
  test("Given a tool call When encoded as JSON Then a completed function_call item is returned", async () => {
    const response = await writeOpenAIResponsesResponse(
      aiSdkPartStream([
        { type: "tool-input-start", id: "call_1", toolName: "get_weather" },
        { type: "tool-input-delta", id: "call_1", delta: '{"city":"Paris"}' },
        { type: "tool-input-end", id: "call_1" },
      ]),
    );

    expect(response.output).toContainEqual({
      type: "function_call",
      id: expect.stringMatching(/^fc_/),
      call_id: "call_1",
      name: "get_weather",
      arguments: '{"city":"Paris"}',
      status: "completed",
    });
  });

  test("Given a tool call When encoded as SSE Then official function-call events share one item id", async () => {
    const events = await frames(
      writeOpenAIResponsesSSE(
        aiSdkPartStream([
          { type: "tool-input-start", id: "call_1", toolName: "get_weather" },
          { type: "tool-input-delta", id: "call_1", delta: '{"city":"Paris"}' },
          { type: "tool-input-end", id: "call_1" },
        ]),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const itemId = events[1]?.item?.id;
    expect(itemId).toStartWith("fc_");
    expect(events[2]?.item_id).toBe(itemId);
    expect(events[3]?.item_id).toBe(itemId);
    expect(events[4]?.item?.id).toBe(itemId);
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
  });

  test("Given mixed output When encoded Then first-appearance order determines output indices", async () => {
    const parts = [
      { type: "text-delta", id: "text-1", text: "Checking" },
      { type: "tool-input-start", id: "call_1", toolName: "first" },
      { type: "tool-input-delta", id: "call_1", delta: "{}" },
      { type: "tool-input-end", id: "call_1" },
      { type: "reasoning-delta", id: "reason-1", text: "Need another tool" },
      { type: "tool-input-start", id: "call_2", toolName: "second" },
      { type: "tool-input-delta", id: "call_2", delta: '{"n":2}' },
      { type: "tool-input-end", id: "call_2" },
    ] as const;

    const response = await writeOpenAIResponsesResponse(aiSdkPartStream(parts));
    expect(response.output.map((item) => item.type)).toEqual([
      "message",
      "function_call",
      "reasoning",
      "function_call",
    ]);

    const events = await frames(writeOpenAIResponsesSSE(aiSdkPartStream(parts)));
    expect(
      events.filter((event) => event.type === "response.output_item.added").map((event) => event.output_index),
    ).toEqual([0, 1, 2, 3]);
  });

  test("Given finish-step metadata When encoded as JSON Then upstream response metadata is reused", async () => {
    const response = await writeOpenAIResponsesResponse(
      aiSdkPartStream([
        { type: "text-delta", id: "text-1", text: "Answer" },
        {
          type: "finish-step",
          response: {
            id: "resp_upstream",
            modelId: "gpt-upstream",
            timestamp: new Date("2026-07-12T00:00:05.000Z"),
          },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          performance: { currentTimestamp: 0 },
          finishReason: "stop",
          rawFinishReason: "stop",
          providerMetadata: undefined,
        },
        { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: {} },
      ]),
      { modelId: "gpt-fallback" },
    );

    expect(response).toMatchObject({ id: "resp_upstream", model: "gpt-upstream", created_at: 1_783_814_405 });
    expect(response.output[0]?.id).toBe("msg_resp_upstream_0");
  });

  test("Given independent response streams When encoded Then ids are unique and event references are consistent", async () => {
    const encode = () =>
      frames(
        writeOpenAIResponsesSSE(
          aiSdkPartStream([
            { type: "reasoning-delta", id: "reason-1", text: "think" },
            { type: "text-delta", id: "text-1", text: "answer" },
            { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: {} },
          ]),
          { modelId: "gpt-routed" },
        ),
      );

    const [first, second] = await Promise.all([encode(), encode()]);
    const responseId = first[0]?.response?.id as string;
    const reasoningId = first.find((event) => event.item?.type === "reasoning")?.item?.id as string;
    const messageId = first.find((event) => event.item?.type === "message")?.item?.id as string;

    expect(responseId).toStartWith("resp_");
    expect(responseId).not.toBe(second[0]?.response?.id);
    expect(first.map((event) => event.sequence_number)).toEqual(first.map((_, index) => index));
    expect(first.find((event) => event.type === "response.reasoning_summary_text.delta")?.item_id).toBe(reasoningId);
    expect(first.find((event) => event.type === "response.output_text.delta")?.item_id).toBe(messageId);
    expect(first.at(-1)?.response).toMatchObject({ id: responseId, model: "gpt-routed" });
  });

  test("Given reasoning stream parts When encoded Then emits exact Responses SSE events", async () => {
    const stream = aiSdkPartStream([
      { type: "reasoning-start", id: "reason-1" },
      { type: "reasoning-delta", id: "reason-1", text: "I should answer." },
      { type: "reasoning-end", id: "reason-1" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "Pong" },
      { type: "text-end", id: "text-1" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
    ]);

    const events = await frames(writeOpenAIResponsesSSE(stream));
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.reasoning_summary_text.delta",
      "response.output_item.added",
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(events[2]).toMatchObject({ delta: "I should answer.", summary_index: 0 });
    expect(events[4]).toMatchObject({ delta: "Pong", content_index: 0, logprobs: [] });
    expect(events[5]?.response).toMatchObject({
      status: "completed",
      output_text: "Pong",
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
    });
  });

  test("Given Anthropic-style provider stream When encoded Then reasoning delta maps without metadata", async () => {
    const stream = partStream([
      {
        type: "reasoning-delta",
        id: "reason-1",
        delta: "private summary",
        providerMetadata: {
          anthropic: {
            signature: "sig",
            encrypted: "cipher",
          },
        },
      },
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        },
      },
    ]);

    const events = await frames(writeOpenAIResponsesSSE(stream));
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.reasoning_summary_text.delta",
      "response.completed",
    ]);
    expect(events[2]).toMatchObject({ delta: "private summary" });
    expect(events[3]?.response?.output[0]).toMatchObject({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "private summary" }],
    });
  });

  test("Given accumulated text and reasoning When encoded as JSON Then Responses object is returned", async () => {
    const stream = aiSdkPartStream([
      { type: "reasoning-delta", id: "reason-1", text: "summary" },
      { type: "text-delta", id: "text-1", text: "Answer" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: {
          inputTokens: undefined,
          outputTokens: 2,
          totalTokens: undefined,
        },
      },
    ]);

    await expect(writeOpenAIResponsesResponse(stream)).resolves.toMatchObject({
      object: "response",
      status: "completed",
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "summary" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Answer", annotations: [] }],
        },
      ],
      output_text: "Answer",
      model: "test-model",
      usage: { input_tokens: 0, output_tokens: 2, total_tokens: 2 },
    });
  });
});
