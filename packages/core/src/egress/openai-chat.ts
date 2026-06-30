import type {
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";

const chunkId = "chatcmpl-aio-proxy";
const encoder = new TextEncoder();

type OpenAIChatFinishReason =
  | "stop"
  | "length"
  | "content_filter"
  | "tool_calls"
  | "error"
  | "other"
  | "unknown";

type OpenAIChatUsage = {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
};

type OpenAIChatChoice = {
  readonly delta: OpenAIChatDelta;
  readonly index: 0;
  readonly finish_reason?: OpenAIChatFinishReason;
};

type OpenAIChatChunk = {
  readonly id: typeof chunkId;
  readonly object: "chat.completion.chunk";
  readonly choices: readonly [OpenAIChatChoice];
  readonly usage?: OpenAIChatUsage;
};

type OpenAIChatDelta = {
  readonly content?: string;
  readonly tool_calls?: readonly [OpenAIChatToolCallDelta];
};

type OpenAIChatToolCallDelta = {
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

export function writeOpenAIChatSSE(
  stream: ReadableStream<LanguageModelV2StreamPart>,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const tools = new Map<string, ToolState>();

      for await (const part of stream) {
        switch (part.type) {
          case "text-delta":
            controller.enqueue(frame({ content: part.delta }));
            break;
          case "tool-input-start": {
            const tool = {
              index: tools.size,
              id: part.id,
              toolName: part.toolName,
              arguments: "",
            };
            tools.set(part.id, tool);
            controller.enqueue(frame({ tool_calls: [toolDelta(tool)] }));
            break;
          }
          case "tool-input-delta": {
            const tool = tools.get(part.id);
            if (tool !== undefined) {
              tool.arguments += part.delta;
              controller.enqueue(frame({ tool_calls: [toolDelta(tool)] }));
            }
            break;
          }
          case "tool-input-end": {
            const tool = tools.get(part.id);
            if (tool !== undefined) {
              controller.enqueue(frame({ tool_calls: [toolDelta(tool)] }));
            }
            break;
          }
          case "finish":
            controller.enqueue(
              frame(
                {},
                openAIFinishReason(part.finishReason),
                openAIUsage(part.usage),
              ),
            );
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

function frame(
  delta: OpenAIChatDelta,
  finishReason?: OpenAIChatFinishReason,
  usage?: OpenAIChatUsage,
): Uint8Array {
  const choice = {
    delta,
    index: 0,
    ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
  } satisfies OpenAIChatChoice;
  const chunk = {
    id: chunkId,
    object: "chat.completion.chunk",
    choices: [choice],
    ...(usage === undefined ? {} : { usage }),
  } satisfies OpenAIChatChunk;

  return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
}

function toolDelta(tool: ToolState): OpenAIChatToolCallDelta {
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

function openAIFinishReason(
  finishReason: LanguageModelV2FinishReason,
): OpenAIChatFinishReason {
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

function openAIUsage(usage: LanguageModelV2Usage): OpenAIChatUsage | undefined {
  const openAIUsage = {
    ...(usage.inputTokens === undefined
      ? {}
      : { prompt_tokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined
      ? {}
      : { completion_tokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined
      ? {}
      : { total_tokens: usage.totalTokens }),
  } satisfies OpenAIChatUsage;

  return Object.keys(openAIUsage).length === 0 ? undefined : openAIUsage;
}
