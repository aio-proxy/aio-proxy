import { expect, test } from "bun:test";
import {
  aiSdkPartStream,
  frames,
  writeOpenAIResponsesResponse,
  writeOpenAIResponsesSSE,
} from "./openai-responses-test-support";

const metadata = {
  aioProxy: {
    openaiResponses: {
      protocol: "openai-responses",
      wireToolType: "custom",
      wireToolName: "exec",
    },
  },
} as const;

test("emits a custom_tool_call JSON item from tool metadata", async () => {
  const response = await writeOpenAIResponsesResponse(
    aiSdkPartStream([
      { type: "tool-input-start", id: "call_1", toolName: "exec", toolMetadata: metadata },
      { type: "tool-input-delta", id: "call_1", delta: '{"input":"pwd"}' },
      { type: "tool-input-end", id: "call_1" },
    ]),
    { modelId: "test-model" },
  );

  expect(response.output).toContainEqual(
    expect.objectContaining({
      type: "custom_tool_call",
      id: expect.stringMatching(/^ctc_/),
      call_id: "call_1",
      name: "exec",
      input: "pwd",
      status: "completed",
    }),
  );
});

test("emits custom tool input SSE events instead of function argument events", async () => {
  const events = await frames(
    writeOpenAIResponsesSSE(
      aiSdkPartStream([
        { type: "tool-input-start", id: "call_1", toolName: "exec", toolMetadata: metadata },
        { type: "tool-input-delta", id: "call_1", delta: '{"input":"pwd"}' },
        { type: "tool-input-end", id: "call_1" },
      ]),
      { modelId: "test-model" },
    ),
  );

  expect(events.map((event) => event.type)).toEqual([
    "response.created",
    "response.output_item.added",
    "response.custom_tool_call_input.delta",
    "response.custom_tool_call_input.done",
    "response.output_item.done",
    "response.completed",
  ]);
  expect(events[1]?.item?.type).toBe("custom_tool_call");
  expect(events[2]?.delta).toBe("pwd");
  expect(events[3]?.input).toBe("pwd");
});
