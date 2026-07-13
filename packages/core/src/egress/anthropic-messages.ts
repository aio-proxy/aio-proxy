import type {
  Message,
  MessageDeltaUsage,
  RawMessageStreamEvent,
  StopReason,
  TextBlock,
  ToolUseBlock,
  Usage,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { LanguageModelV2FinishReason, LanguageModelV2StreamPart, TextStreamPart, ToolSet } from "../ai-sdk-bridge";
import type { ModelEgressContext } from "../protocol/adapter";
import { createCancellableEgressStream } from "./cancellable-stream";

const encoder = new TextEncoder();

type AnthropicMessagesStreamPart = LanguageModelV2StreamPart | TextStreamPart<ToolSet>;
export type AnthropicMessageResponse = Message;

type TextDeltaPart = Extract<AnthropicMessagesStreamPart, { type: "text-delta" }>;
type FinishPart = Extract<AnthropicMessagesStreamPart, { type: "finish" }>;
type FinishStepPart = Extract<AnthropicMessagesStreamPart, { type: "finish-step" }>;
type FinishReason = FinishPart["finishReason"] | LanguageModelV2FinishReason;
type TokenUsage = {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
};

export async function writeAnthropicMessagesResponse(
  stream: ReadableStream<AnthropicMessagesStreamPart>,
  context: ModelEgressContext,
): Promise<Message> {
  type TextState = { readonly type: "text"; readonly id: string; text: string };
  type ToolState = { readonly type: "tool_use"; readonly id: string; readonly name: string; input: string };

  const content: (TextState | ToolState)[] = [];
  const texts = new Map<string, TextState>();
  const tools = new Map<string, ToolState>();
  let stopReason: StopReason = "end_turn";
  let usage = anthropicUsage({});
  let response = { id: messageId(), modelId: context.modelId };

  for await (const part of stream) {
    switch (part.type) {
      case "text-start": {
        const text = { type: "text" as const, id: part.id, text: "" };
        texts.set(part.id, text);
        content.push(text);
        break;
      }
      case "text-delta": {
        let text = texts.get(part.id);
        if (text === undefined) {
          text = { type: "text", id: part.id, text: "" };
          texts.set(part.id, text);
          content.push(text);
        }
        text.text += textDelta(part);
        break;
      }
      case "text-end":
        texts.delete(part.id);
        break;
      case "tool-input-start": {
        const tool = { type: "tool_use" as const, id: part.id, name: part.toolName, input: "" };
        tools.set(part.id, tool);
        content.push(tool);
        break;
      }
      case "tool-input-delta": {
        const tool = tools.get(part.id);
        if (tool !== undefined) tool.input += part.delta;
        break;
      }
      case "tool-input-end":
        tools.delete(part.id);
        break;
      case "finish-step":
        response = responseMetadata(part, response);
        break;
      case "finish":
        stopReason = anthropicStopReason(part.finishReason);
        usage = anthropicUsage(finishUsage(part));
        break;
      default:
        break;
    }
  }

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    container: null,
    content: content.map((part): TextBlock | ToolUseBlock =>
      part.type === "text"
        ? { type: "text", text: part.text, citations: null }
        : {
            type: "tool_use",
            id: part.id,
            name: part.name,
            input: parseJson(part.input),
            caller: { type: "direct" },
          },
    ),
    model: response.modelId,
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

export function writeAnthropicMessagesSSE(
  stream: ReadableStream<AnthropicMessagesStreamPart>,
  context: ModelEgressContext,
): ReadableStream<Uint8Array> {
  const id = messageId();
  return createCancellableEgressStream(stream, async ({ parts, enqueue }) => {
    let nextIndex = 0;
    let text: { readonly id: string; readonly index: number } | undefined;
    const texts = new Map<string, number>();
    const tools = new Map<string, number>();
    const openBlocks = new Set<number>();

    enqueue(
      event({
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          container: null,
          content: [],
          model: context.modelId,
          stop_details: null,
          stop_reason: null,
          stop_sequence: null,
          usage: anthropicUsage({}),
        },
      }),
    );

    for await (const part of parts) {
      switch (part.type) {
        case "text-start":
          if (!texts.has(part.id)) {
            if (text !== undefined && openBlocks.delete(text.index)) enqueue(contentBlockStop(text.index));
            text = { id: part.id, index: nextIndex++ };
            texts.set(part.id, text.index);
            openBlocks.add(text.index);
            enqueue(textStart(text.index));
          }
          break;
        case "text-delta": {
          let index = texts.get(part.id);
          if (index === undefined) {
            if (text !== undefined && openBlocks.delete(text.index)) enqueue(contentBlockStop(text.index));
            text = { id: part.id, index: nextIndex++ };
            index = text.index;
            texts.set(part.id, index);
            openBlocks.add(index);
            enqueue(textStart(index));
          }
          if (openBlocks.has(index)) {
            enqueue(
              event({ type: "content_block_delta", index, delta: { type: "text_delta", text: textDelta(part) } }),
            );
          }
          break;
        }
        case "text-end": {
          const index = texts.get(part.id);
          if (index !== undefined && openBlocks.delete(index)) enqueue(contentBlockStop(index));
          if (text?.id === part.id) text = undefined;
          break;
        }
        case "tool-input-start": {
          if (text !== undefined && openBlocks.delete(text.index)) {
            enqueue(contentBlockStop(text.index));
            text = undefined;
          }
          const index = nextIndex++;
          tools.set(part.id, index);
          openBlocks.add(index);
          enqueue(
            event({
              type: "content_block_start",
              index,
              content_block: {
                type: "tool_use",
                id: part.id,
                name: part.toolName,
                input: {},
                caller: { type: "direct" },
              },
            }),
          );
          break;
        }
        case "tool-input-delta": {
          const index = tools.get(part.id);
          if (index !== undefined && openBlocks.has(index)) {
            enqueue(
              event({
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
          if (index !== undefined && openBlocks.delete(index)) enqueue(contentBlockStop(index));
          break;
        }
        case "finish":
          for (const index of openBlocks) enqueue(contentBlockStop(index));
          openBlocks.clear();
          text = undefined;
          enqueue(
            event({
              type: "message_delta",
              delta: {
                container: null,
                stop_details: null,
                stop_reason: anthropicStopReason(part.finishReason),
                stop_sequence: null,
              },
              usage: messageDeltaUsage(finishUsage(part)),
            }),
          );
          break;
        default:
          break;
      }
    }

    for (const index of openBlocks) enqueue(contentBlockStop(index));
    enqueue(event({ type: "message_stop" }));
  });
}

function messageId(): string {
  return `msg_${crypto.randomUUID()}`;
}

function responseMetadata(
  part: FinishStepPart,
  fallback: { readonly id: string; readonly modelId: string },
): { readonly id: string; readonly modelId: string } {
  return "response" in part ? { id: part.response.id, modelId: part.response.modelId } : fallback;
}

function textStart(index: number): Uint8Array {
  return event({
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "", citations: null },
  });
}

function contentBlockStop(index: number): Uint8Array {
  return event({ type: "content_block_stop", index });
}

function textDelta(part: TextDeltaPart): string {
  return "delta" in part ? part.delta : part.text;
}

function finishUsage(part: FinishPart): TokenUsage {
  return "usage" in part ? part.usage : part.totalUsage;
}

function anthropicUsage(usage: TokenUsage): Usage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
  };
}

function messageDeltaUsage(usage: TokenUsage): MessageDeltaUsage {
  return {
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    input_tokens: usage.inputTokens ?? null,
    output_tokens: usage.outputTokens ?? 0,
    output_tokens_details: null,
    server_tool_use: null,
  };
}

function anthropicStopReason(finishReason: FinishReason): StopReason {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool-calls":
      return "tool_use";
    case "content-filter":
      return "refusal";
    case "error":
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
    if (error instanceof SyntaxError) return value;
    throw error;
  }
}

function event(value: RawMessageStreamEvent): Uint8Array {
  return encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}
