import type {
  Response,
  ResponseCustomToolCallItem,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseStatus,
  ResponseUsage,
} from "openai/resources/responses/responses";
import type { LanguageModelV2StreamPart, TextStreamPart, ToolSet } from "../../ai-sdk-bridge";
import { OpenAIResponsesTransformError } from "../../error";
import { readOpenAIResponsesWireMetadata } from "../../transform/openai-responses-tools";

export type OpenAIResponsesStreamPart = LanguageModelV2StreamPart | TextStreamPart<ToolSet>;
export type TextDeltaPart = Extract<OpenAIResponsesStreamPart, { type: "text-delta" }>;
export type ReasoningDeltaPart = Extract<OpenAIResponsesStreamPart, { type: "reasoning-delta" }>;
export type FinishPart = Extract<OpenAIResponsesStreamPart, { type: "finish" }>;
export type FinishStepPart = Extract<OpenAIResponsesStreamPart, { type: "finish-step" }>;
export type ToolStartPart = Extract<OpenAIResponsesStreamPart, { type: "tool-input-start" }>;

export type ResponseMetadata = {
  readonly id: string;
  readonly messageId: string;
  readonly reasoningId: string;
  readonly model: string;
  readonly createdAt: number;
};

export type ToolState = {
  readonly id: string;
  readonly callId: string;
  readonly wireType: "function" | "custom";
  readonly name: string;
  readonly namespace?: string;
  input: string;
  completed: boolean;
};

export type OutputItemRef =
  | { readonly type: "message" }
  | { readonly type: "reasoning" }
  | { readonly type: "tool"; readonly callId: string };

export type ResponseState = {
  readonly text: string[];
  readonly reasoning: string[];
  readonly tools: Map<string, ToolState>;
  readonly output: OutputItemRef[];
  metadata: ResponseMetadata;
  usage?: ResponseUsage;
};

export function responseState(modelId: string): ResponseState {
  return { text: [], reasoning: [], tools: new Map(), output: [], metadata: fallbackMetadata(modelId) };
}

export function startTool(part: ToolStartPart): ToolState {
  const metadata = readOpenAIResponsesWireMetadata("toolMetadata" in part ? part.toolMetadata : undefined);
  const wireType = metadata?.wireToolType === "custom" ? "custom" : "function";
  return {
    id: `${wireType === "custom" ? "ctc" : "fc"}_${crypto.randomUUID()}`,
    callId: part.id,
    wireType,
    name: metadata?.wireToolName ?? part.toolName,
    ...(metadata?.namespace === undefined ? {} : { namespace: metadata.namespace }),
    input: "",
    completed: false,
  };
}

export function upstreamMetadata(part: FinishStepPart, fallback: ResponseMetadata): ResponseMetadata {
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

export function responseObject(status: ResponseStatus, state: ResponseState): Response {
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

export function ensureOutput(
  state: ResponseState,
  output: OutputItemRef,
): { readonly index: number; readonly added: boolean } {
  const index = outputIndex(state, output);
  if (index >= 0) return { index, added: false };
  state.output.push(output);
  return { index: state.output.length - 1, added: true };
}

export function outputIndex(state: ResponseState, output: OutputItemRef): number {
  return output.type === "tool"
    ? state.output.findIndex((item) => item.type === "tool" && item.callId === output.callId)
    : state.output.findIndex((item) => item.type === output.type);
}

export function reasoningItem(state: ResponseState, status: "in_progress" | "completed"): ResponseReasoningItem {
  return {
    id: state.metadata.reasoningId,
    type: "reasoning",
    summary: state.reasoning.length === 0 ? [] : [{ type: "summary_text", text: state.reasoning.join("") }],
    status,
  };
}

export function messageItem(state: ResponseState, status: "in_progress" | "completed"): ResponseOutputMessage {
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

export function toolItem(
  tool: ToolState,
  status: "in_progress" | "completed",
): ResponseFunctionToolCall | ResponseCustomToolCallItem {
  if (tool.wireType === "custom") {
    return {
      id: tool.id,
      type: "custom_tool_call",
      call_id: tool.callId,
      name: tool.name,
      input: status === "completed" ? customInput(tool.input) : "",
      status,
      ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
    };
  }
  return {
    id: tool.id,
    type: "function_call",
    call_id: tool.callId,
    name: tool.name,
    arguments: tool.input,
    status,
    ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
  };
}

export function textDelta(part: TextDeltaPart): string {
  return "delta" in part ? part.delta : part.text;
}

export function reasoningDelta(part: ReasoningDeltaPart): string {
  return "delta" in part ? part.delta : part.text;
}

export function finishUsage(part: FinishPart): {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
} {
  return "usage" in part ? part.usage : part.totalUsage;
}

export function openAIUsage(usage: {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
}): ResponseUsage | undefined {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined && usage.totalTokens === undefined)
    return undefined;
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

export function customInput(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 &&
      "input" in parsed &&
      typeof parsed.input === "string"
    ) {
      return parsed.input;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  throw new OpenAIResponsesTransformError("output.custom_tool_call.input");
}

function outputItems(state: ResponseState): ResponseOutputItem[] {
  const items: ResponseOutputItem[] = [];
  for (const output of state.output) {
    if (output.type === "reasoning") items.push(reasoningItem(state, "completed"));
    if (output.type === "message") items.push(messageItem(state, "completed"));
    if (output.type === "tool") {
      const tool = state.tools.get(output.callId);
      if (tool !== undefined) items.push(toolItem(tool, "completed"));
    }
  }
  return items;
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
