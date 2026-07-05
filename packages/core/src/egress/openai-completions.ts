import type { LanguageModelV2FinishReason, LanguageModelV2StreamPart, TextStreamPart, ToolSet } from "../ai-sdk-bridge";

const encoder = new TextEncoder();

type OpenAICompletionsFinishReason =
  | "stop"
  | "length"
  | "content_filter"
  | "tool_calls"
  | "error"
  | "other"
  | "unknown";

type OpenAICompletionsUsage = {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
};

type OpenAICompletionsChoice = {
  readonly delta: OpenAICompletionsDelta;
  readonly index: 0;
  readonly finish_reason?: OpenAICompletionsFinishReason;
};

type OpenAICompletionsResponseChoice = {
  readonly finish_reason: OpenAICompletionsFinishReason;
  readonly index: 0;
  readonly message: {
    readonly role: "assistant";
    readonly content: string;
  };
};

type OpenAICompletionsResponse = {
  readonly id: string;
  readonly object: "chat.completion";
  readonly choices: readonly [OpenAICompletionsResponseChoice];
  readonly usage?: OpenAICompletionsUsage;
};

type OpenAICompletionsChunk = {
  readonly id: string;
  readonly object: "chat.completion.chunk";
  readonly choices: readonly [OpenAICompletionsChoice];
  readonly usage?: OpenAICompletionsUsage;
};

type OpenAICompletionsDelta = {
  readonly content?: string;
  readonly tool_calls?: readonly [OpenAICompletionsToolCallDelta];
};

type OpenAICompletionsToolCallDelta = {
  readonly index: number;
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
};

type ToolState = {
  readonly index: number;
  readonly id: string;
  readonly toolName: string;
  arguments: string;
};

type OpenAICompletionsStreamPart = LanguageModelV2StreamPart | TextStreamPart<ToolSet>;

type TextDeltaPart = Extract<OpenAICompletionsStreamPart, { type: "text-delta" }>;
type FinishPart = Extract<OpenAICompletionsStreamPart, { type: "finish" }>;
type FinishReason = FinishPart["finishReason"] | LanguageModelV2FinishReason;
type TokenUsage = {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
};

export function writeOpenAICompletionsSSE(
  stream: ReadableStream<OpenAICompletionsStreamPart>,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const id = completionId();
      const tools = new Map<string, ToolState>();

      for await (const part of stream) {
        switch (part.type) {
          case "text-delta":
            controller.enqueue(frame(id, { content: textDelta(part) }));
            break;
          case "tool-input-start": {
            const tool = {
              index: tools.size,
              id: part.id,
              toolName: part.toolName,
              arguments: "",
            };
            tools.set(part.id, tool);
            controller.enqueue(frame(id, { tool_calls: [toolDelta(tool)] }));
            break;
          }
          case "tool-input-delta": {
            const tool = tools.get(part.id);
            if (tool !== undefined) {
              tool.arguments += part.delta;
              controller.enqueue(frame(id, { tool_calls: [toolDelta(tool)] }));
            }
            break;
          }
          case "tool-input-end": {
            const tool = tools.get(part.id);
            if (tool !== undefined) {
              controller.enqueue(frame(id, { tool_calls: [toolDelta(tool)] }));
            }
            break;
          }
          case "finish":
            controller.enqueue(frame(id, {}, openAIFinishReason(part.finishReason), openAIUsage(finishUsage(part))));
            break;
          default:
            break;
        }
      }

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

export async function writeOpenAICompletionsResponse(
  stream: ReadableStream<OpenAICompletionsStreamPart>,
): Promise<OpenAICompletionsResponse> {
  const text: string[] = [];
  let finishReason: OpenAICompletionsFinishReason = "unknown";
  let usage: OpenAICompletionsUsage | undefined;

  for await (const part of stream) {
    switch (part.type) {
      case "text-delta":
        text.push(textDelta(part));
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
    id: completionId(),
    object: "chat.completion",
    choices: [
      {
        finish_reason: finishReason,
        index: 0,
        message: { role: "assistant", content: text.join("") },
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  };
}

function textDelta(part: TextDeltaPart): string {
  return "delta" in part ? part.delta : part.text;
}

function finishUsage(part: FinishPart): TokenUsage {
  return "usage" in part ? part.usage : part.totalUsage;
}

function frame(
  id: string,
  delta: OpenAICompletionsDelta,
  finishReason?: OpenAICompletionsFinishReason,
  usage?: OpenAICompletionsUsage,
): Uint8Array {
  const choice = {
    delta,
    index: 0,
    ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
  } satisfies OpenAICompletionsChoice;
  const chunk = {
    id,
    object: "chat.completion.chunk",
    choices: [choice],
    ...(usage === undefined ? {} : { usage }),
  } satisfies OpenAICompletionsChunk;

  return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
}

function completionId(): string {
  return `chatcmpl-${crypto.randomUUID()}`;
}

function toolDelta(tool: ToolState): OpenAICompletionsToolCallDelta {
  return {
    index: tool.index,
    id: tool.id,
    type: "function",
    function: {
      name: tool.toolName,
      arguments: tool.arguments,
    },
  };
}

function openAIFinishReason(finishReason: FinishReason): OpenAICompletionsFinishReason {
  switch (finishReason) {
    case "content-filter":
      return "content_filter";
    case "tool-calls":
      return "tool_calls";
    case "stop":
    case "length":
    case "error":
    case "other":
    case "unknown":
      return finishReason;
  }
}

function openAIUsage(usage: TokenUsage): OpenAICompletionsUsage | undefined {
  const openAIUsage = {
    ...(usage.inputTokens === undefined ? {} : { prompt_tokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { completion_tokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { total_tokens: usage.totalTokens }),
  } satisfies OpenAICompletionsUsage;

  return Object.keys(openAIUsage).length === 0 ? undefined : openAIUsage;
}
