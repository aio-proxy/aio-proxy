import type {
  Message,
  StopReason,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages";

import type { LanguageModelV2StreamPart, TextStreamPart, ToolSet } from "../../ai-sdk-bridge";
import type { ModelEgressContext } from "../../protocol/adapter";

import {
  anthropicStopReason,
  anthropicUsage,
  messageId,
  parseJson,
  reasoningSignature,
  type TokenUsage,
} from "./format";

type AnthropicMessagesStreamPart = LanguageModelV2StreamPart | TextStreamPart<ToolSet>;
type TextDeltaPart = Extract<AnthropicMessagesStreamPart, { type: "text-delta" }>;
type ReasoningDeltaPart = Extract<AnthropicMessagesStreamPart, { type: "reasoning-delta" }>;
type FinishPart = Extract<AnthropicMessagesStreamPart, { type: "finish" }>;
type FinishStepPart = Extract<AnthropicMessagesStreamPart, { type: "finish-step" }>;
type TextState = { readonly type: "text"; readonly id: string; text: string };
type ThinkingState = {
  readonly type: "thinking";
  readonly id: string;
  thinking: string;
  signature: string | undefined;
};
type ToolState = { readonly type: "tool_use"; readonly id: string; readonly name: string; input: string };

export type AnthropicMessageResponse = Message;

export async function writeAnthropicMessagesResponse(
  stream: ReadableStream<AnthropicMessagesStreamPart>,
  context: ModelEgressContext,
): Promise<Message> {
  const content: (TextState | ThinkingState | ToolState)[] = [];
  const texts = new Map<string, TextState>();
  const thinking = new Map<string, ThinkingState>();
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
      case "reasoning-start": {
        const state = { type: "thinking" as const, id: part.id, thinking: "", signature: reasoningSignature(part) };
        thinking.set(part.id, state);
        content.push(state);
        break;
      }
      case "reasoning-delta": {
        let state = thinking.get(part.id);
        if (state === undefined) {
          state = { type: "thinking", id: part.id, thinking: "", signature: reasoningSignature(part) };
          thinking.set(part.id, state);
          content.push(state);
        }
        state.thinking += reasoningDelta(part);
        state.signature = reasoningSignature(part) ?? state.signature;
        break;
      }
      case "reasoning-end": {
        const state = thinking.get(part.id);
        if (state !== undefined) state.signature = reasoningSignature(part) ?? state.signature;
        thinking.delete(part.id);
        break;
      }
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
    content: content.flatMap((part): (TextBlock | ThinkingBlock | ToolUseBlock)[] => {
      if (part.type === "text") return [{ type: "text", text: part.text, citations: null }];
      if (part.type === "thinking") {
        return part.signature === undefined
          ? []
          : [{ type: "thinking", thinking: part.thinking, signature: part.signature }];
      }
      return [
        {
          type: "tool_use",
          id: part.id,
          name: part.name,
          input: parseJson(part.input),
          caller: { type: "direct" },
        },
      ];
    }),
    model: response.modelId,
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

function responseMetadata(
  part: FinishStepPart,
  fallback: { readonly id: string; readonly modelId: string },
): { readonly id: string; readonly modelId: string } {
  return "response" in part ? { id: part.response.id, modelId: part.response.modelId } : fallback;
}

function textDelta(part: TextDeltaPart): string {
  return "delta" in part ? part.delta : part.text;
}

function reasoningDelta(part: ReasoningDeltaPart): string {
  return "delta" in part ? part.delta : part.text;
}

function finishUsage(part: FinishPart): TokenUsage {
  return "usage" in part ? part.usage : part.totalUsage;
}
