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

type TextDeltaPart = Extract<AnthropicMessagesStreamPart, { type: "text-delta" }>;
type FinishPart = Extract<AnthropicMessagesStreamPart, { type: "finish" }>;
type FinishReason = FinishPart["finishReason"] | LanguageModelV2FinishReason;
type TokenUsage = {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
};

export function writeAnthropicMessagesSSE(
  stream: ReadableStream<AnthropicMessagesStreamPart>,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      let textStarted = false;
      let textStopped = false;

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
            if (!textStarted) {
              controller.enqueue(textStart());
              textStarted = true;
            }
            controller.enqueue(
              event("content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: textDelta(part) },
              }),
            );
            break;
          case "finish":
            if (textStarted && !textStopped) {
              controller.enqueue(textStop());
              textStopped = true;
            }
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

      if (textStarted && !textStopped) {
        controller.enqueue(textStop());
      }

      controller.enqueue(event("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });
}

function textStart(): Uint8Array {
  return event("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
}

function textStop(): Uint8Array {
  return event("content_block_stop", {
    type: "content_block_stop",
    index: 0,
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

function event(name: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}
