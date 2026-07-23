import type { OpenAIResponsesRequest } from "../../ingress/openai-responses";
import type {
  OpenAIResponsesModelMessages,
  OpenAIResponsesProviderOptions,
  OpenAIResponsesToolChoice,
  OpenAIResponsesTransformSettings,
  OpenAIResponsesTransformTool,
} from "./types";

import { openAIResponsesInputMessages } from "./compat";
import {
  normalizeOpenAIResponsesTools,
  readOpenAIResponsesWireMetadata,
  rejectOpenAIResponsesFeature,
  warnOpenAIResponsesDegradation,
} from "./tools";

const supportedRequestKeys = new Set([
  "model",
  "input",
  "tools",
  "reasoning",
  "stream",
  "temperature",
  "top_p",
  "max_output_tokens",
  "parallel_tool_calls",
  "tool_choice",
  "store",
  "background",
  "conversation",
  "previous_response_id",
  "metadata",
  "session_id",
  "conversation_id",
  "include",
  "client_metadata",
  "prompt_cache_key",
  "service_tier",
  "text",
]);

export function openAIResponsesToModelMessages(request: OpenAIResponsesRequest): OpenAIResponsesModelMessages {
  validateModelCompatibility(request);
  const input = typeof request.input === "string" ? undefined : request.input;
  const tools = normalizeOpenAIResponsesTools([
    { tools: request.tools, source: "request" },
    ...(input ?? [])
      .map((item, inputIndex) =>
        item.type === "additional_tools"
          ? { tools: item.tools, source: "additional_tools" as const, inputIndex }
          : undefined,
      )
      .filter((source) => source !== undefined),
  ]);
  return {
    messages:
      typeof request.input === "string"
        ? [{ role: "user", content: request.input }]
        : openAIResponsesInputMessages(request.input),
    ...(tools === undefined ? {} : { tools }),
    settings: transformSettings(request, tools),
  };
}

function validateModelCompatibility(request: OpenAIResponsesRequest): void {
  if (request.store === true) rejectOpenAIResponsesFeature("store", "store");
  const unknown = Object.keys(request).find((key) => !supportedRequestKeys.has(key));
  if (unknown !== undefined) rejectOpenAIResponsesFeature(unknown, unknown);
  if (request.include !== undefined) warnOpenAIResponsesDegradation("include", "include", "dropped");
  if (request.client_metadata !== undefined)
    warnOpenAIResponsesDegradation("client_metadata", "client_metadata", "stripped");
  if (request.service_tier !== undefined) warnOpenAIResponsesDegradation("service_tier", "service_tier", "dropped");
  if (request.text?.verbosity !== undefined)
    warnOpenAIResponsesDegradation("text.verbosity", "text.verbosity", "dropped");
  if (request.reasoning?.context !== undefined)
    warnOpenAIResponsesDegradation("reasoning.context", "reasoning.context", "dropped");
  if (request.background === true) warnOpenAIResponsesDegradation("background", "background", "synchronous");
}

function transformSettings(
  request: OpenAIResponsesRequest,
  tools: readonly OpenAIResponsesTransformTool[] | undefined,
): OpenAIResponsesTransformSettings {
  const providerOptions: OpenAIResponsesProviderOptions = {
    openai: {
      store: false,
      ...(request.reasoning?.summary === undefined ? {} : { reasoningSummary: request.reasoning.summary }),
    },
  };
  const toolChoice = transformToolChoice(request.tool_choice, tools);
  return {
    ...(request.stream === undefined ? {} : { stream: request.stream }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.top_p === undefined ? {} : { topP: request.top_p }),
    ...(request.max_output_tokens === undefined ? {} : { maxOutputTokens: request.max_output_tokens }),
    ...(request.parallel_tool_calls === undefined ? {} : { parallelToolCalls: request.parallel_tool_calls }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(request.reasoning?.effort === undefined ? {} : { reasoning: request.reasoning.effort }),
    ...(request.reasoning?.summary === undefined ? {} : { reasoningSummary: request.reasoning.summary }),
    providerOptions,
  };
}

function transformToolChoice(
  choice: OpenAIResponsesRequest["tool_choice"],
  tools: readonly OpenAIResponsesTransformTool[] | undefined,
): OpenAIResponsesToolChoice | undefined {
  if (choice === undefined || typeof choice === "string") return choice;
  if (!isNamedToolChoice(choice)) return rejectOpenAIResponsesFeature("tool_choice", "tool_choice");

  const matches = (tools ?? []).filter((tool) => {
    const metadata = readOpenAIResponsesWireMetadata(tool.metadata);
    return metadata?.wireToolType === choice.type && metadata.wireToolName === choice.name;
  });
  const match = matches.length === 1 ? matches[0] : undefined;
  if (match === undefined) return rejectOpenAIResponsesFeature("tool_choice", "tool_choice");
  return { type: "tool", toolName: match.name };
}

function isNamedToolChoice(value: Record<string, unknown>): value is { type: "function" | "custom"; name: string } {
  const candidate = value as { readonly type?: unknown; readonly name?: unknown };
  return (candidate.type === "function" || candidate.type === "custom") && typeof candidate.name === "string";
}
