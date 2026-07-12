import type {
  Candidate,
  FinishReason as GeminiFinishReason,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  Part,
} from "@google/genai";
import type { TextStreamPart, ToolSet } from "../ai-sdk-bridge";
import type { ModelEgressContext } from "../protocol/adapter";

const encoder = new TextEncoder();

type GeminiGenerateContentStreamPart = TextStreamPart<ToolSet>;
type TextDeltaPart = Extract<GeminiGenerateContentStreamPart, { type: "text-delta" }>;
type FinishPart = Extract<GeminiGenerateContentStreamPart, { type: "finish" }>;
type FinishStepPart = Extract<GeminiGenerateContentStreamPart, { type: "finish-step" }>;
type FinishReason = FinishPart["finishReason"];
type TokenUsage = FinishPart["totalUsage"];

export type GeminiResponse = Pick<
  GenerateContentResponse,
  "candidates" | "createTime" | "modelVersion" | "responseId" | "usageMetadata"
>;

type ToolState = {
  readonly id: string;
  readonly toolName: string;
  input: string;
};

type ResponseMetadata = {
  readonly id: string;
  readonly model: string;
  readonly createTime: string;
};

export async function writeGeminiGenerateContentResponse(
  stream: ReadableStream<GeminiGenerateContentStreamPart>,
  context: ModelEgressContext,
): Promise<GeminiResponse> {
  const text: string[] = [];
  const tools = new Map<string, ToolState>();
  let finishReason = geminiFinishReason("other");
  let usage: GenerateContentResponseUsageMetadata | undefined;
  let metadata = fallbackMetadata(context.modelId);

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
        if (tool !== undefined) tool.input += part.delta;
        break;
      }
      case "finish-step":
        metadata = upstreamMetadata(part, metadata);
        break;
      case "finish":
        finishReason = geminiFinishReason(part.finishReason);
        usage = geminiUsage(part.totalUsage);
        break;
      default:
        break;
    }
  }

  return response(
    metadata,
    [...(text.length === 0 ? [] : [{ text: text.join("") }]), ...Array.from(tools.values()).map(toolPart)],
    finishReason,
    usage,
  );
}

export function writeGeminiGenerateContentSSE(
  stream: ReadableStream<GeminiGenerateContentStreamPart>,
  context: ModelEgressContext,
): ReadableStream<Uint8Array> {
  const metadata = fallbackMetadata(context.modelId);
  return new ReadableStream({
    async start(controller) {
      const tools = new Map<string, ToolState>();

      for await (const part of stream) {
        switch (part.type) {
          case "text-delta":
            controller.enqueue(frame(metadata, [{ text: textDelta(part) }]));
            break;
          case "tool-input-start":
            tools.set(part.id, { id: part.id, toolName: part.toolName, input: "" });
            break;
          case "tool-input-delta": {
            const tool = tools.get(part.id);
            if (tool !== undefined) tool.input += part.delta;
            break;
          }
          case "tool-input-end": {
            const tool = tools.get(part.id);
            if (tool !== undefined) controller.enqueue(frame(metadata, [toolPart(tool)]));
            break;
          }
          case "finish":
            controller.enqueue(
              frame(metadata, [], geminiFinishReason(part.finishReason), geminiUsage(part.totalUsage)),
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

function fallbackMetadata(model: string): ResponseMetadata {
  return { id: `resp_${crypto.randomUUID()}`, model, createTime: new Date().toISOString() };
}

function upstreamMetadata(part: FinishStepPart, fallback: ResponseMetadata): ResponseMetadata {
  if (!("response" in part)) return fallback;
  return {
    id: part.response.id,
    model: part.response.modelId,
    createTime: part.response.timestamp.toISOString(),
  };
}

function response(
  metadata: ResponseMetadata,
  parts: Part[],
  finishReason?: GeminiFinishReason,
  usage?: GenerateContentResponseUsageMetadata,
): GeminiResponse {
  const candidate: Candidate = {
    content: { role: "model", parts },
    ...(finishReason === undefined ? {} : { finishReason }),
  };
  return {
    candidates: [candidate],
    createTime: metadata.createTime,
    modelVersion: metadata.model,
    responseId: metadata.id,
    ...(usage === undefined ? {} : { usageMetadata: usage }),
  };
}

function frame(
  metadata: ResponseMetadata,
  parts: Part[],
  finishReason?: GeminiFinishReason,
  usage?: GenerateContentResponseUsageMetadata,
): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(response(metadata, parts, finishReason, usage))}\n\n`);
}

function textDelta(part: TextDeltaPart): string {
  return part.text;
}

function toolPart(tool: ToolState): Part {
  return {
    functionCall: {
      id: tool.id,
      name: tool.toolName,
      args: parseJsonObject(tool.input),
    },
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : {};
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

function geminiFinishReason(finishReason: FinishReason): GeminiFinishReason {
  switch (finishReason) {
    case "length":
      return "MAX_TOKENS" as GeminiFinishReason;
    case "content-filter":
      return "SAFETY" as GeminiFinishReason;
    case "stop":
    case "tool-calls":
      return "STOP" as GeminiFinishReason;
    case "error":
    case "other":
      return "OTHER" as GeminiFinishReason;
  }
}

function geminiUsage(usage: TokenUsage): GenerateContentResponseUsageMetadata | undefined {
  const metadata: GenerateContentResponseUsageMetadata = {
    ...(usage.inputTokens === undefined ? {} : { promptTokenCount: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { candidatesTokenCount: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokenCount: usage.totalTokens }),
  };
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}
