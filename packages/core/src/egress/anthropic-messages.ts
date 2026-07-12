import type { LanguageModelV2FinishReason, LanguageModelV2StreamPart, TextStreamPart, ToolSet } from "../ai-sdk-bridge";

const messageId = "msg_aio_proxy";
const model = "aio-proxy";
const encoder = new TextEncoder();

type AnthropicStopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "error";

type AnthropicUsage = {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
};

type AnthropicMessagesStreamPart = LanguageModelV2StreamPart | TextStreamPart<ToolSet>;

export type AnthropicMessageResponse = {
  readonly id: typeof messageId;
  readonly type: "message";
  readonly role: "assistant";
  readonly content: readonly (
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown }
  )[];
  readonly model: typeof model;
  readonly stop_reason: AnthropicStopReason;
  readonly stop_sequence: null;
  readonly usage?: AnthropicUsage;
};

type TextDeltaPart = Extract<AnthropicMessagesStreamPart, { type: "text-delta" }>;
type FinishPart = Extract<AnthropicMessagesStreamPart, { type: "finish" }>;
type FinishReason = FinishPart["finishReason"] | LanguageModelV2FinishReason;
type TokenUsage = {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
};

export async function writeAnthropicMessagesResponse(
  stream: ReadableStream<AnthropicMessagesStreamPart>,
): Promise<AnthropicMessageResponse> {
  const text: string[] = [];
  const tools = new Map<string, { readonly id: string; readonly name: string; input: string }>();
  let stopReason: AnthropicStopReason = "end_turn";
  let usage: AnthropicUsage | undefined;

  for await (const part of stream) {
    switch (part.type) {
      case "text-delta":
        text.push(textDelta(part));
        break;
      case "tool-input-start":
        tools.set(part.id, { id: part.id, name: part.toolName, input: "" });
        break;
      case "tool-input-delta": {
        const tool = tools.get(part.id);
        if (tool !== undefined) {
          tool.input += part.delta;
        }
        break;
      }
      case "finish":
        stopReason = anthropicStopReason(part.finishReason);
        usage = anthropicUsage(finishUsage(part)).usage;
        break;
      default:
        break;
    }
  }

  return {
    id: messageId,
    type: "message",
    role: "assistant",
    content: [
      ...(text.length === 0 ? [] : [{ type: "text" as const, text: text.join("") }]),
      ...Array.from(tools.values(), (tool) => ({
        type: "tool_use" as const,
        id: tool.id,
        name: tool.name,
        input: parseJson(tool.input),
      })),
    ],
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    ...(usage === undefined ? {} : { usage }),
  };
}

export function writeAnthropicMessagesSSE(
  stream: ReadableStream<AnthropicMessagesStreamPart>,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      let nextIndex = 0;
      let textIndex: number | undefined;
      const tools = new Map<string, number>();
      const openBlocks = new Set<number>();

      controller.enqueue(
        event("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );

      for await (const part of stream) {
        switch (part.type) {
          case "text-delta":
            if (textIndex === undefined) {
              textIndex = nextIndex;
              nextIndex += 1;
              openBlocks.add(textIndex);
              controller.enqueue(textStart(textIndex));
            }
            controller.enqueue(
              event("content_block_delta", {
                type: "content_block_delta",
                index: textIndex,
                delta: { type: "text_delta", text: textDelta(part) },
              }),
            );
            break;
          case "text-end":
            if (textIndex !== undefined && openBlocks.delete(textIndex)) {
              controller.enqueue(contentBlockStop(textIndex));
              textIndex = undefined;
            }
            break;
          case "tool-input-start": {
            if (textIndex !== undefined && openBlocks.delete(textIndex)) {
              controller.enqueue(contentBlockStop(textIndex));
              textIndex = undefined;
            }
            const index = nextIndex;
            nextIndex += 1;
            tools.set(part.id, index);
            openBlocks.add(index);
            controller.enqueue(
              event("content_block_start", {
                type: "content_block_start",
                index,
                content_block: { type: "tool_use", id: part.id, name: part.toolName, input: {} },
              }),
            );
            break;
          }
          case "tool-input-delta": {
            const index = tools.get(part.id);
            if (index !== undefined && openBlocks.has(index)) {
              controller.enqueue(
                event("content_block_delta", {
                  type: "content_block_delta",
                  index,
                  delta: { type: "input_json_delta", partial_json: part.delta },
                }),
              );
            }
            break;
          }
          case "tool-input-end": {
            const index = tools.get(part.id);
            if (index !== undefined && openBlocks.delete(index)) {
              controller.enqueue(contentBlockStop(index));
            }
            break;
          }
          case "finish":
            for (const index of openBlocks) {
              controller.enqueue(contentBlockStop(index));
            }
            openBlocks.clear();
            textIndex = undefined;
            controller.enqueue(
              event("message_delta", {
                type: "message_delta",
                delta: {
                  stop_reason: anthropicStopReason(part.finishReason),
                  stop_sequence: null,
                },
                ...anthropicUsage(finishUsage(part)),
              }),
            );
            break;
          default:
            break;
        }
      }

      for (const index of openBlocks) {
        controller.enqueue(contentBlockStop(index));
      }

      controller.enqueue(event("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });
}

function textStart(index: number): Uint8Array {
  return event("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  });
}

function contentBlockStop(index: number): Uint8Array {
  return event("content_block_stop", {
    type: "content_block_stop",
    index,
  });
}

function textDelta(part: TextDeltaPart): string {
  return "delta" in part ? part.delta : part.text;
}

function finishUsage(part: FinishPart): TokenUsage {
  return "usage" in part ? part.usage : part.totalUsage;
}

function anthropicUsage(usage: TokenUsage): {
  readonly usage?: AnthropicUsage;
} {
  const anthropicUsage = {
    ...(usage.inputTokens === undefined ? {} : { input_tokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { output_tokens: usage.outputTokens }),
  } satisfies AnthropicUsage;

  return Object.keys(anthropicUsage).length === 0 ? {} : { usage: anthropicUsage };
}

function anthropicStopReason(finishReason: FinishReason): AnthropicStopReason {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool-calls":
      return "tool_use";
    case "content-filter":
    case "error":
      return "error";
    case "stop":
    case "unknown":
    case "other":
      return "end_turn";
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return value;
    }
    throw error;
  }
}

function event(name: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}
