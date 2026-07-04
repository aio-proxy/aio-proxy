import type { LanguageModelV2StreamPart, TextStreamPart, ToolSet } from "../ai-sdk-bridge";

const responseId = "resp-aio-proxy";
const messageId = "msg-aio-proxy";
const reasoningId = "rs-aio-proxy";
const encoder = new TextEncoder();

type OpenAIResponsesStatus = "in_progress" | "completed";
type OpenAIResponsesStreamPart = LanguageModelV2StreamPart | TextStreamPart<ToolSet>;
type TextDeltaPart = Extract<OpenAIResponsesStreamPart, { type: "text-delta" }>;
type ReasoningDeltaPart = Extract<OpenAIResponsesStreamPart, { type: "reasoning-delta" }>;
type FinishPart = Extract<OpenAIResponsesStreamPart, { type: "finish" }>;

type OpenAIResponsesUsage = {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
};

type OpenAIResponsesMessageItem = {
  readonly id: typeof messageId;
  readonly type: "message";
  readonly role: "assistant";
  readonly content: readonly OpenAIResponsesOutputText[];
};

type OpenAIResponsesReasoningItem = {
  readonly id: typeof reasoningId;
  readonly type: "reasoning";
  readonly summary: readonly OpenAIResponsesSummaryText[];
};

type OpenAIResponsesOutputText = {
  readonly type: "output_text";
  readonly text: string;
};

type OpenAIResponsesSummaryText = {
  readonly type: "summary_text";
  readonly text: string;
};

type OpenAIResponsesOutputItem = OpenAIResponsesReasoningItem | OpenAIResponsesMessageItem;

export type OpenAIResponsesResponse = {
  readonly id: typeof responseId;
  readonly object: "response";
  readonly status: OpenAIResponsesStatus;
  readonly output: readonly OpenAIResponsesOutputItem[];
  readonly usage?: OpenAIResponsesUsage;
};

type ResponseState = {
  readonly text: string[];
  readonly reasoning: string[];
  usage?: OpenAIResponsesUsage;
};

export function writeOpenAIResponsesSSE(stream: ReadableStream<OpenAIResponsesStreamPart>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const state: ResponseState = { text: [], reasoning: [] };
      let textItemAdded = false;
      let reasoningItemAdded = false;

      controller.enqueue(
        frame("response.created", {
          type: "response.created",
          response: responseObject("in_progress", state),
        }),
      );

      for await (const part of stream) {
        switch (part.type) {
          case "reasoning-delta":
            if (!reasoningItemAdded) {
              reasoningItemAdded = true;
              controller.enqueue(reasoningAddedFrame(0));
            }
            state.reasoning.push(reasoningDelta(part));
            controller.enqueue(
              frame("response.reasoning_summary_text.delta", {
                type: "response.reasoning_summary_text.delta",
                output_index: 0,
                summary_index: 0,
                delta: reasoningDelta(part),
              }),
            );
            break;
          case "text-delta": {
            const outputIndex = reasoningItemAdded ? 1 : 0;
            if (!textItemAdded) {
              textItemAdded = true;
              controller.enqueue(messageAddedFrame(outputIndex));
            }
            state.text.push(textDelta(part));
            controller.enqueue(
              frame("response.output_text.delta", {
                type: "response.output_text.delta",
                output_index: outputIndex,
                content_index: 0,
                delta: textDelta(part),
              }),
            );
            break;
          }
          case "finish":
            {
              const usage = openAIUsage(finishUsage(part));
              if (usage !== undefined) {
                state.usage = usage;
              }
            }
            break;
          default:
            break;
        }
      }

      controller.enqueue(
        frame("response.completed", {
          type: "response.completed",
          response: responseObject("completed", state),
        }),
      );
      controller.close();
    },
  });
}

export async function writeOpenAIResponsesResponse(
  stream: ReadableStream<OpenAIResponsesStreamPart>,
): Promise<OpenAIResponsesResponse> {
  const state: ResponseState = { text: [], reasoning: [] };

  for await (const part of stream) {
    switch (part.type) {
      case "reasoning-delta":
        state.reasoning.push(reasoningDelta(part));
        break;
      case "text-delta":
        state.text.push(textDelta(part));
        break;
      case "finish":
        {
          const usage = openAIUsage(finishUsage(part));
          if (usage !== undefined) {
            state.usage = usage;
          }
        }
        break;
      default:
        break;
    }
  }

  return responseObject("completed", state);
}

function responseObject(status: OpenAIResponsesStatus, state: ResponseState): OpenAIResponsesResponse {
  return {
    id: responseId,
    object: "response",
    status,
    output: outputItems(state),
    ...(state.usage === undefined ? {} : { usage: state.usage }),
  };
}

function outputItems(state: ResponseState): readonly OpenAIResponsesOutputItem[] {
  return [
    ...(state.reasoning.length === 0
      ? []
      : [
          {
            id: reasoningId,
            type: "reasoning",
            summary: [{ type: "summary_text", text: state.reasoning.join("") }],
          } satisfies OpenAIResponsesReasoningItem,
        ]),
    ...(state.text.length === 0
      ? []
      : [
          {
            id: messageId,
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: state.text.join("") }],
          } satisfies OpenAIResponsesMessageItem,
        ]),
  ];
}

function reasoningAddedFrame(outputIndex: number): Uint8Array {
  return frame("response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: { id: reasoningId, type: "reasoning", summary: [] },
  });
}

function messageAddedFrame(outputIndex: number): Uint8Array {
  return frame("response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: { id: messageId, type: "message", role: "assistant", content: [] },
  });
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
}): OpenAIResponsesUsage | undefined {
  const value = {
    ...(usage.inputTokens === undefined ? {} : { input_tokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { output_tokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { total_tokens: usage.totalTokens }),
  } satisfies OpenAIResponsesUsage;

  return Object.keys(value).length === 0 ? undefined : value;
}

function frame(event: string, data: object): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
