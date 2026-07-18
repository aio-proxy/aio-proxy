import type { Response, ResponseStreamEvent } from "openai/resources/responses/responses";
import type { LanguageModelV2StreamPart, TextStreamPart, ToolSet } from "../ai-sdk-bridge";
import type { ModelEgressContext } from "../protocol/adapter";
import { createCancellableEgressStream } from "./cancellable-stream";
import {
  ensureOutput,
  messageItem,
  openAIUsage,
  outputIndex,
  reasoningItem,
  responseObject,
  responseState,
  toolItem,
  upstreamMetadata,
} from "./openai-responses/response-state";

const encoder = new TextEncoder();
type OpenAIResponsesStreamPart = LanguageModelV2StreamPart | TextStreamPart<ToolSet>;
type TextDeltaPart = Extract<OpenAIResponsesStreamPart, { type: "text-delta" }>;
type ReasoningDeltaPart = Extract<OpenAIResponsesStreamPart, { type: "reasoning-delta" }>;
type FinishPart = Extract<OpenAIResponsesStreamPart, { type: "finish" }>;
type FinishStepPart = Extract<OpenAIResponsesStreamPart, { type: "finish-step" }>;

export type OpenAIResponsesResponse = Response;

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
        case "error":
          throw part.error;
        case "finish-step":
          assertSuccessfulFinish(part);
          break;
        case "finish": {
          assertSuccessfulFinish(part);
          const usage = openAIUsage(finishUsage(part));
          if (usage !== undefined) state.usage = usage;
          break;
        }
        default:
          break;
      }
    }

    const response = responseObject("completed", state);
    send({
      type: "response.completed",
      sequence_number: sequenceNumber,
      response,
    });
    context.onResponseId?.(response.id);
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
      case "error":
        throw part.error;
      case "finish-step":
        assertSuccessfulFinish(part);
        if ("response" in part) state.metadata = upstreamMetadata(part.response, state.metadata);
        break;
      case "finish": {
        assertSuccessfulFinish(part);
        const usage = openAIUsage(finishUsage(part));
        if (usage !== undefined) state.usage = usage;
        break;
      }
      default:
        break;
    }
  }

  const response = responseObject("completed", state);
  context.onResponseId?.(response.id);
  return response;
}

function textDelta(part: TextDeltaPart): string {
  return "delta" in part ? part.delta : part.text;
}

function reasoningDelta(part: ReasoningDeltaPart): string {
  return "delta" in part ? part.delta : part.text;
}

function assertSuccessfulFinish(part: FinishPart | FinishStepPart): void {
  if (part.finishReason !== "error") return;
  const rawReason = "rawFinishReason" in part ? part.rawFinishReason : undefined;
  throw new Error(rawReason ?? "Model stream finished with an error");
}

function finishUsage(part: FinishPart): {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
} {
  return "usage" in part ? part.usage : part.totalUsage;
}

function frame(value: ResponseStreamEvent): Uint8Array {
  return encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}
