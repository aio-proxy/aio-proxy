import type {
  Response,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseStatus,
  ResponseStreamEvent,
  ResponseUsage,
} from "openai/resources/responses/responses";
import type { LanguageModelV2StreamPart, TextStreamPart, ToolSet } from "../ai-sdk-bridge";
import type { ModelEgressContext } from "../protocol/adapter";
import { createCancellableEgressStream } from "./cancellable-stream";

const encoder = new TextEncoder();

type OpenAIResponsesStreamPart = LanguageModelV2StreamPart | TextStreamPart<ToolSet>;
type TextDeltaPart = Extract<OpenAIResponsesStreamPart, { type: "text-delta" }>;
type ReasoningDeltaPart = Extract<OpenAIResponsesStreamPart, { type: "reasoning-delta" }>;
type FinishPart = Extract<OpenAIResponsesStreamPart, { type: "finish" }>;
type FinishStepPart = Extract<OpenAIResponsesStreamPart, { type: "finish-step" }>;

export type OpenAIResponsesResponse = Response;

type ResponseMetadata = {
  readonly id: string;
  readonly messageId: string;
  readonly reasoningId: string;
  readonly model: string;
  readonly createdAt: number;
};

type ToolState = {
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  arguments: string;
  completed: boolean;
};

type OutputItemRef =
  | { readonly type: "message" }
  | { readonly type: "reasoning" }
  | { readonly type: "tool"; readonly callId: string };

type ResponseState = {
  readonly text: string[];
  readonly reasoning: string[];
  readonly tools: Map<string, ToolState>;
  readonly output: OutputItemRef[];
  metadata: ResponseMetadata;
  usage?: ResponseUsage;
};

export function writeOpenAIResponsesSSE(
  stream: ReadableStream<OpenAIResponsesStreamPart>,
  context: ModelEgressContext,
): ReadableStream<Uint8Array> {
  return createCancellableEgressStream(stream, async ({ parts, enqueue }) => {
    const state = responseState(context.modelId);
    let sequenceNumber = 0;
    const send = (value: ResponseStreamEvent) => {
      enqueue(frame(value));
      sequenceNumber += 1;
    };

    send({
      type: "response.created",
      sequence_number: sequenceNumber,
      response: responseObject("in_progress", state),
    });

    for await (const part of parts) {
      switch (part.type) {
        case "reasoning-delta": {
          const output = ensureOutput(state, { type: "reasoning" });
          if (output.added) {
            send({
              type: "response.output_item.added",
              sequence_number: sequenceNumber,
              output_index: output.index,
              item: reasoningItem(state, "in_progress"),
            });
          }
          const delta = reasoningDelta(part);
          state.reasoning.push(delta);
          send({
            type: "response.reasoning_summary_text.delta",
            sequence_number: sequenceNumber,
            item_id: state.metadata.reasoningId,
            output_index: output.index,
            summary_index: 0,
            delta,
          });
          break;
        }
        case "text-delta": {
          const output = ensureOutput(state, { type: "message" });
          if (output.added) {
            send({
              type: "response.output_item.added",
              sequence_number: sequenceNumber,
              output_index: output.index,
              item: messageItem(state, "in_progress"),
            });
          }
          const delta = textDelta(part);
          state.text.push(delta);
          send({
            type: "response.output_text.delta",
            sequence_number: sequenceNumber,
            item_id: state.metadata.messageId,
            output_index: output.index,
            content_index: 0,
            delta,
            logprobs: [],
          });
          break;
        }
        case "tool-input-start": {
          if (state.tools.has(part.id)) break;
          const tool = {
            id: `fc_${crypto.randomUUID()}`,
            callId: part.id,
            name: part.toolName,
            arguments: "",
            completed: false,
          };
          state.tools.set(part.id, tool);
          const output = ensureOutput(state, { type: "tool", callId: part.id });
          send({
            type: "response.output_item.added",
            sequence_number: sequenceNumber,
            output_index: output.index,
            item: toolItem(tool, "in_progress"),
          });
          break;
        }
        case "tool-input-delta": {
          const tool = state.tools.get(part.id);
          if (tool === undefined || tool.completed) break;
          tool.arguments += part.delta;
          send({
            type: "response.function_call_arguments.delta",
            sequence_number: sequenceNumber,
            item_id: tool.id,
            output_index: outputIndex(state, { type: "tool", callId: part.id }),
            delta: part.delta,
          });
          break;
        }
        case "tool-input-end": {
          const tool = state.tools.get(part.id);
          if (tool === undefined || tool.completed) break;
          tool.completed = true;
          const index = outputIndex(state, { type: "tool", callId: part.id });
          send({
            type: "response.function_call_arguments.done",
            sequence_number: sequenceNumber,
            item_id: tool.id,
            output_index: index,
            name: tool.name,
            arguments: tool.arguments,
          });
          send({
            type: "response.output_item.done",
            sequence_number: sequenceNumber,
            output_index: index,
            item: toolItem(tool, "completed"),
          });
          break;
        }
        case "finish": {
          const usage = openAIUsage(finishUsage(part));
          if (usage !== undefined) state.usage = usage;
          break;
        }
        default:
          break;
      }
    }

    send({
      type: "response.completed",
      sequence_number: sequenceNumber,
      response: responseObject("completed", state),
    });
  });
}

export async function writeOpenAIResponsesResponse(
  stream: ReadableStream<OpenAIResponsesStreamPart>,
  context: ModelEgressContext,
): Promise<Response> {
  const state = responseState(context.modelId);

  for await (const part of stream) {
    switch (part.type) {
      case "reasoning-delta":
        ensureOutput(state, { type: "reasoning" });
        state.reasoning.push(reasoningDelta(part));
        break;
      case "text-delta":
        ensureOutput(state, { type: "message" });
        state.text.push(textDelta(part));
        break;
      case "tool-input-start":
        if (!state.tools.has(part.id)) {
          state.tools.set(part.id, {
            id: `fc_${crypto.randomUUID()}`,
            callId: part.id,
            name: part.toolName,
            arguments: "",
            completed: false,
          });
          ensureOutput(state, { type: "tool", callId: part.id });
        }
        break;
      case "tool-input-delta": {
        const tool = state.tools.get(part.id);
        if (tool !== undefined && !tool.completed) tool.arguments += part.delta;
        break;
      }
      case "tool-input-end": {
        const tool = state.tools.get(part.id);
        if (tool !== undefined) tool.completed = true;
        break;
      }
      case "finish-step":
        state.metadata = upstreamMetadata(part, state.metadata);
        break;
      case "finish": {
        const usage = openAIUsage(finishUsage(part));
        if (usage !== undefined) state.usage = usage;
        break;
      }
      default:
        break;
    }
  }

  return responseObject("completed", state);
}

function responseState(modelId: string): ResponseState {
  return {
    text: [],
    reasoning: [],
    tools: new Map(),
    output: [],
    metadata: fallbackMetadata(modelId),
  };
}

function fallbackMetadata(model: string): ResponseMetadata {
  const id = `resp_${crypto.randomUUID()}`;
  return {
    id,
    messageId: `msg_${id}_0`,
    reasoningId: `rs_${id}_0`,
    model,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

function upstreamMetadata(part: FinishStepPart, fallback: ResponseMetadata): ResponseMetadata {
  if (!("response" in part)) return fallback;
  const id = part.response.id;
  return {
    ...fallback,
    id,
    messageId: `msg_${id}_0`,
    reasoningId: `rs_${id}_0`,
    model: part.response.modelId,
    createdAt: Math.floor(part.response.timestamp.getTime() / 1000),
  };
}

function responseObject(status: ResponseStatus, state: ResponseState): Response {
  return {
    id: state.metadata.id,
    created_at: state.metadata.createdAt,
    output_text: state.text.join(""),
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: state.metadata.model,
    object: "response",
    output: outputItems(state),
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    status,
    ...(status === "completed" ? { completed_at: Math.floor(Date.now() / 1000) } : {}),
    ...(state.usage === undefined ? {} : { usage: state.usage }),
  };
}

function outputItems(state: ResponseState): ResponseOutputItem[] {
  const items: ResponseOutputItem[] = [];
  for (const output of state.output) {
    switch (output.type) {
      case "reasoning":
        items.push(reasoningItem(state, "completed"));
        break;
      case "message":
        items.push(messageItem(state, "completed"));
        break;
      case "tool": {
        const tool = state.tools.get(output.callId);
        if (tool !== undefined) items.push(toolItem(tool, "completed"));
        break;
      }
    }
  }
  return items;
}

function ensureOutput(
  state: ResponseState,
  output: OutputItemRef,
): { readonly index: number; readonly added: boolean } {
  const index = outputIndex(state, output);
  if (index >= 0) return { index, added: false };
  state.output.push(output);
  return { index: state.output.length - 1, added: true };
}

function outputIndex(state: ResponseState, output: OutputItemRef): number {
  return output.type === "tool"
    ? state.output.findIndex((item) => item.type === "tool" && item.callId === output.callId)
    : state.output.findIndex((item) => item.type === output.type);
}

function reasoningItem(state: ResponseState, status: "in_progress" | "completed"): ResponseReasoningItem {
  return {
    id: state.metadata.reasoningId,
    type: "reasoning",
    summary: state.reasoning.length === 0 ? [] : [{ type: "summary_text", text: state.reasoning.join("") }],
    status,
  };
}

function messageItem(state: ResponseState, status: "in_progress" | "completed"): ResponseOutputMessage {
  return {
    id: state.metadata.messageId,
    type: "message",
    role: "assistant",
    status,
    content:
      state.text.length === 0
        ? []
        : [{ type: "output_text", text: state.text.join(""), annotations: [], logprobs: [] }],
  };
}

function toolItem(tool: ToolState, status: "in_progress" | "completed"): ResponseFunctionToolCall {
  return {
    id: tool.id,
    type: "function_call",
    call_id: tool.callId,
    name: tool.name,
    arguments: tool.arguments,
    status,
  };
}

function textDelta(part: TextDeltaPart): string {
  return "delta" in part ? part.delta : part.text;
}

function reasoningDelta(part: ReasoningDeltaPart): string {
  return "delta" in part ? part.delta : part.text;
}

function finishUsage(part: FinishPart): {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
} {
  return "usage" in part ? part.usage : part.totalUsage;
}

function openAIUsage(usage: {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
}): ResponseUsage | undefined {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined && usage.totalTokens === undefined) {
    return undefined;
  }
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: usage.totalTokens ?? inputTokens + outputTokens,
  };
}

function frame(value: ResponseStreamEvent): Uint8Array {
  return encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}
