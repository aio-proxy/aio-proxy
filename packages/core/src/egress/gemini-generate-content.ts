import type { TextStreamPart, ToolSet } from "../ai-sdk-bridge";

const encoder = new TextEncoder();

type GeminiGenerateContentStreamPart = TextStreamPart<ToolSet>;
type TextDeltaPart = Extract<
  GeminiGenerateContentStreamPart,
  { type: "text-delta" }
>;
type FinishPart = Extract<GeminiGenerateContentStreamPart, { type: "finish" }>;
type FinishReason = FinishPart["finishReason"];
type TokenUsage = FinishPart["totalUsage"];

type GeminiPart =
  | {
      readonly text: string;
    }
  | {
      readonly functionCall: {
        readonly name: string;
        readonly args: unknown;
      };
    };

type GeminiResponse = {
  readonly candidates: readonly [
    {
      readonly content: {
        readonly role: "model";
        readonly parts: readonly GeminiPart[];
      };
      readonly finishReason?: GeminiFinishReason;
    },
  ];
  readonly usageMetadata?: GeminiUsageMetadata;
};

type GeminiFinishReason = "STOP" | "MAX_TOKENS" | "SAFETY" | "OTHER";

type GeminiUsageMetadata = {
  readonly promptTokenCount?: number;
  readonly candidatesTokenCount?: number;
  readonly totalTokenCount?: number;
};

type ToolState = {
  readonly id: string;
  readonly toolName: string;
  input: string;
};

export async function writeGeminiGenerateContentResponse(
  stream: ReadableStream<GeminiGenerateContentStreamPart>,
): Promise<GeminiResponse> {
  const text: string[] = [];
  const tools = new Map<string, ToolState>();
  let finishReason: GeminiFinishReason = "OTHER";
  let usage: GeminiUsageMetadata | undefined;

  for await (const part of stream) {
    switch (part.type) {
      case "text-delta":
        text.push(textDelta(part));
        break;
      case "tool-input-start":
        tools.set(part.id, { id: part.id, toolName: part.toolName, input: "" });
        break;
      case "tool-input-delta": {
        const tool = tools.get(part.id);
        if (tool !== undefined) {
          tool.input += part.delta;
        }
        break;
      }
      case "finish":
        finishReason = geminiFinishReason(part.finishReason);
        usage = geminiUsage(part.totalUsage);
        break;
      default:
        break;
    }
  }

  return response(
    [
      ...(text.length === 0 ? [] : [{ text: text.join("") }]),
      ...Array.from(tools.values()).map(toolPart),
    ],
    finishReason,
    usage,
  );
}

export function writeGeminiGenerateContentSSE(
  stream: ReadableStream<GeminiGenerateContentStreamPart>,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const tools = new Map<string, ToolState>();

      for await (const part of stream) {
        switch (part.type) {
          case "text-delta":
            controller.enqueue(frame([{ text: textDelta(part) }]));
            break;
          case "tool-input-start":
            tools.set(part.id, {
              id: part.id,
              toolName: part.toolName,
              input: "",
            });
            break;
          case "tool-input-delta": {
            const tool = tools.get(part.id);
            if (tool !== undefined) {
              tool.input += part.delta;
            }
            break;
          }
          case "tool-input-end": {
            const tool = tools.get(part.id);
            if (tool !== undefined) {
              controller.enqueue(frame([toolPart(tool)]));
            }
            break;
          }
          case "finish":
            controller.enqueue(
              frame(
                [],
                geminiFinishReason(part.finishReason),
                geminiUsage(part.totalUsage),
              ),
            );
            break;
          default:
            break;
        }
      }

      controller.close();
    },
  });
}

function response(
  parts: readonly GeminiPart[],
  finishReason?: GeminiFinishReason,
  usage?: GeminiUsageMetadata,
): GeminiResponse {
  return {
    candidates: [
      {
        content: { role: "model", parts },
        ...(finishReason === undefined ? {} : { finishReason }),
      },
    ],
    ...(usage === undefined ? {} : { usageMetadata: usage }),
  };
}

function frame(
  parts: readonly GeminiPart[],
  finishReason?: GeminiFinishReason,
  usage?: GeminiUsageMetadata,
): Uint8Array {
  return encoder.encode(
    `data: ${JSON.stringify(response(parts, finishReason, usage))}\n\n`,
  );
}

function textDelta(part: TextDeltaPart): string {
  return part.text;
}

function toolPart(tool: ToolState): GeminiPart {
  return {
    functionCall: {
      name: tool.toolName,
      args: parseJson(tool.input),
    },
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return value;
    }

    throw error;
  }
}

function geminiFinishReason(finishReason: FinishReason): GeminiFinishReason {
  switch (finishReason) {
    case "length":
      return "MAX_TOKENS";
    case "content-filter":
      return "SAFETY";
    case "stop":
    case "tool-calls":
      return "STOP";
    case "error":
    case "other":
      return "OTHER";
  }
}

function geminiUsage(usage: TokenUsage): GeminiUsageMetadata | undefined {
  const metadata = {
    ...(usage.inputTokens === undefined
      ? {}
      : { promptTokenCount: usage.inputTokens }),
    ...(usage.outputTokens === undefined
      ? {}
      : { candidatesTokenCount: usage.outputTokens }),
    ...(usage.totalTokens === undefined
      ? {}
      : { totalTokenCount: usage.totalTokens }),
  } satisfies GeminiUsageMetadata;

  return Object.keys(metadata).length === 0 ? undefined : metadata;
}
