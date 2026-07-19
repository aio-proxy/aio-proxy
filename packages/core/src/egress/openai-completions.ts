import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions/completions";
import type { CompletionUsage } from "openai/resources/completions";

import type { LanguageModelV2FinishReason, LanguageModelV2StreamPart, TextStreamPart, ToolSet } from "../ai-sdk-bridge";
import type { ModelEgressContext } from "../protocol/adapter";

import { createCancellableEgressStream } from "./cancellable-stream";

const encoder = new TextEncoder();

type ToolState = {
  readonly index: number;
  readonly id: string;
  readonly toolName: string;
  arguments: string;
};

type OpenAICompletionsStreamPart = LanguageModelV2StreamPart | TextStreamPart<ToolSet>;
type TextDeltaPart = Extract<OpenAICompletionsStreamPart, { type: "text-delta" }>;
type FinishPart = Extract<OpenAICompletionsStreamPart, { type: "finish" }>;
type FinishStepPart = Extract<OpenAICompletionsStreamPart, { type: "finish-step" }>;
type FinishReason = FinishPart["finishReason"] | LanguageModelV2FinishReason;
type TokenUsage = {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
};
type ResponseMetadata = {
  readonly id: string;
  readonly model: string;
  readonly created: number;
};

export function writeOpenAICompletionsSSE(
  stream: ReadableStream<OpenAICompletionsStreamPart>,
  context: ModelEgressContext,
): ReadableStream<Uint8Array> {
  const metadata = fallbackMetadata(context.modelId);
  return createCancellableEgressStream(stream, async ({ parts, enqueue }) => {
    const tools = new Map<string, ToolState>();

    for await (const part of parts) {
      switch (part.type) {
        case "text-delta":
          enqueue(frame(metadata, { content: textDelta(part) }));
          break;
        case "tool-input-start": {
          const tool = { index: tools.size, id: part.id, toolName: part.toolName, arguments: "" };
          tools.set(part.id, tool);
          enqueue(frame(metadata, { tool_calls: [toolDelta(tool)] }));
          break;
        }
        case "tool-input-delta": {
          const tool = tools.get(part.id);
          if (tool !== undefined) {
            tool.arguments += part.delta;
            enqueue(frame(metadata, { tool_calls: [toolDelta(tool)] }));
          }
          break;
        }
        case "tool-input-end": {
          const tool = tools.get(part.id);
          if (tool !== undefined) enqueue(frame(metadata, { tool_calls: [toolDelta(tool)] }));
          break;
        }
        case "finish":
          enqueue(frame(metadata, {}, openAIFinishReason(part.finishReason), openAIUsage(finishUsage(part))));
          break;
        default:
          break;
      }
    }

    enqueue(encoder.encode("data: [DONE]\n\n"));
  });
}

export async function writeOpenAICompletionsResponse(
  stream: ReadableStream<OpenAICompletionsStreamPart>,
  context: ModelEgressContext,
): Promise<ChatCompletion> {
  const text: string[] = [];
  const tools = new Map<string, ToolState>();
  let finishReason: ChatCompletion.Choice["finish_reason"] = "stop";
  let usage: CompletionUsage | undefined;
  let metadata = fallbackMetadata(context.modelId);

  for await (const part of stream) {
    switch (part.type) {
      case "text-delta":
        text.push(textDelta(part));
        break;
      case "tool-input-start":
        tools.set(part.id, { index: tools.size, id: part.id, toolName: part.toolName, arguments: "" });
        break;
      case "tool-input-delta": {
        const tool = tools.get(part.id);
        if (tool !== undefined) tool.arguments += part.delta;
        break;
      }
      case "finish-step":
        metadata = upstreamMetadata(part, metadata);
        break;
      case "finish":
        finishReason = openAIFinishReason(part.finishReason);
        usage = openAIUsage(finishUsage(part));
        break;
      default:
        break;
    }
  }

  return {
    id: metadata.id,
    object: "chat.completion",
    created: metadata.created,
    model: metadata.model,
    choices: [
      {
        finish_reason: finishReason,
        index: 0,
        logprobs: null,
        message: {
          role: "assistant",
          content: text.length === 0 && tools.size > 0 ? null : text.join(""),
          refusal: null,
          ...(tools.size === 0 ? {} : { tool_calls: [...tools.values()].map(messageToolCall) }),
        },
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  };
}

function fallbackMetadata(model: string): ResponseMetadata {
  return { id: completionId(), model, created: Math.floor(Date.now() / 1000) };
}

function upstreamMetadata(part: FinishStepPart, fallback: ResponseMetadata): ResponseMetadata {
  if (!("response" in part)) return fallback;
  return {
    id: part.response.id,
    model: part.response.modelId,
    created: Math.floor(part.response.timestamp.getTime() / 1000),
  };
}

function textDelta(part: TextDeltaPart): string {
  return "delta" in part ? part.delta : part.text;
}

function finishUsage(part: FinishPart): TokenUsage {
  return "usage" in part ? part.usage : part.totalUsage;
}

function frame(
  metadata: ResponseMetadata,
  delta: ChatCompletionChunk.Choice.Delta,
  finishReason: ChatCompletionChunk.Choice["finish_reason"] = null,
  usage?: CompletionUsage,
): Uint8Array {
  const chunk: ChatCompletionChunk = {
    id: metadata.id,
    object: "chat.completion.chunk",
    created: metadata.created,
    model: metadata.model,
    choices: [{ delta, index: 0, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  };
  return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
}

function completionId(): string {
  return `chatcmpl-${crypto.randomUUID()}`;
}

function toolDelta(tool: ToolState): ChatCompletionChunk.Choice.Delta.ToolCall {
  return {
    index: tool.index,
    id: tool.id,
    type: "function",
    function: { name: tool.toolName, arguments: tool.arguments },
  };
}

function messageToolCall(tool: ToolState): ChatCompletionMessageToolCall {
  return {
    id: tool.id,
    type: "function",
    function: { name: tool.toolName, arguments: tool.arguments },
  };
}

function openAIFinishReason(finishReason: FinishReason): ChatCompletion.Choice["finish_reason"] {
  switch (finishReason) {
    case "content-filter":
      return "content_filter";
    case "tool-calls":
      return "tool_calls";
    case "length":
      return "length";
    case "stop":
    case "error":
    case "other":
    case "unknown":
      return "stop";
  }
}

function openAIUsage(usage: TokenUsage): CompletionUsage | undefined {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined && usage.totalTokens === undefined) {
    return undefined;
  }
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.totalTokens ?? promptTokens + completionTokens,
  };
}
