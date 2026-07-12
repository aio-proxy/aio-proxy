import type {
  Response,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseStatus,
  ResponseStreamEvent,
  ResponseUsage,
} from "openai/resources/responses/responses";
import type { LanguageModelV2StreamPart, TextStreamPart, ToolSet } from "../ai-sdk-bridge";
import type { ModelEgressContext } from "../protocol/adapter";

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

type ResponseState = {
  readonly text: string[];
  readonly reasoning: string[];
  metadata: ResponseMetadata;
  usage?: ResponseUsage;
};

export function writeOpenAIResponsesSSE(
  stream: ReadableStream<OpenAIResponsesStreamPart>,
  context: ModelEgressContext,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const state: ResponseState = { text: [], reasoning: [], metadata: fallbackMetadata(context.modelId) };
      let textItemAdded = false;
      let reasoningItemAdded = false;
      let sequenceNumber = 0;
      const send = (value: ResponseStreamEvent) => {
        controller.enqueue(frame(value));
        sequenceNumber += 1;
      };

      send({
        type: "response.created",
        sequence_number: sequenceNumber,
        response: responseObject("in_progress", state),
      });

      for await (const part of stream) {
        switch (part.type) {
          case "reasoning-delta": {
            const outputIndex = 0;
            if (!reasoningItemAdded) {
              reasoningItemAdded = true;
              send({
                type: "response.output_item.added",
                sequence_number: sequenceNumber,
                output_index: outputIndex,
                item: reasoningItem(state, "in_progress"),
              });
            }
            const delta = reasoningDelta(part);
            state.reasoning.push(delta);
            send({
              type: "response.reasoning_summary_text.delta",
              sequence_number: sequenceNumber,
              item_id: state.metadata.reasoningId,
              output_index: outputIndex,
              summary_index: 0,
              delta,
            });
            break;
          }
          case "text-delta": {
            const outputIndex = reasoningItemAdded ? 1 : 0;
            if (!textItemAdded) {
              textItemAdded = true;
              send({
                type: "response.output_item.added",
                sequence_number: sequenceNumber,
                output_index: outputIndex,
                item: messageItem(state, "in_progress"),
              });
            }
            const delta = textDelta(part);
            state.text.push(delta);
            send({
              type: "response.output_text.delta",
              sequence_number: sequenceNumber,
              item_id: state.metadata.messageId,
              output_index: outputIndex,
              content_index: 0,
              delta,
              logprobs: [],
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
      controller.close();
    },
  });
}

export async function writeOpenAIResponsesResponse(
  stream: ReadableStream<OpenAIResponsesStreamPart>,
  context: ModelEgressContext,
): Promise<Response> {
  const state: ResponseState = { text: [], reasoning: [], metadata: fallbackMetadata(context.modelId) };

  for await (const part of stream) {
    switch (part.type) {
      case "reasoning-delta":
        state.reasoning.push(reasoningDelta(part));
        break;
      case "text-delta":
        state.text.push(textDelta(part));
        break;
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
  return [
    ...(state.reasoning.length === 0 ? [] : [reasoningItem(state, "completed")]),
    ...(state.text.length === 0 ? [] : [messageItem(state, "completed")]),
  ];
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
