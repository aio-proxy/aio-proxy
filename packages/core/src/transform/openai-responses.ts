import type { ModelMessage, TextPart } from "../ai-sdk-bridge";
import type {
  OpenAIResponsesInputMessage,
  OpenAIResponsesRequest,
  OpenAIResponsesTool,
} from "../ingress/openai-responses";
import type {
  OpenAIResponsesModelMessages,
  OpenAIResponsesTransformSettings,
  OpenAIResponsesTransformTool,
} from "./openai-responses-types";

export { modelMessagesToOpenAIResponses } from "./openai-responses-from-model";
export type {
  OpenAIResponsesFromModelMessages,
  OpenAIResponsesModelMessages,
  OpenAIResponsesProviderOptions,
  OpenAIResponsesReasoningEffort,
  OpenAIResponsesReasoningSummary,
  OpenAIResponsesTransformSettings,
  OpenAIResponsesTransformTool,
} from "./openai-responses-types";

export function openAIResponsesToModelMessages(request: OpenAIResponsesRequest): OpenAIResponsesModelMessages {
  return {
    messages:
      typeof request.input === "string" ? [{ role: "user", content: request.input }] : request.input.map(inputMessage),
    ...(request.tools === undefined ? {} : { tools: request.tools.map(transformTool) }),
    settings: transformSettings(request),
  };
}

function inputMessage(message: OpenAIResponsesInputMessage): ModelMessage {
  switch (message.role) {
    case "system":
      return { role: "system", content: textContent(message.content) };
    case "user":
      return { role: "user", content: textModelContent(message.content) };
    case "assistant":
      return { role: "assistant", content: textModelContent(message.content) };
  }
}

function transformTool(tool: OpenAIResponsesTool): OpenAIResponsesTransformTool {
  switch (tool.type) {
    case "function":
      return {
        type: "function",
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.parameters === undefined ? {} : { inputSchema: tool.parameters }),
      };
    case "custom":
      return {
        type: "custom",
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.format === undefined ? {} : { format: tool.format }),
      };
  }
}

function transformSettings(request: OpenAIResponsesRequest): OpenAIResponsesTransformSettings {
  const providerOptions =
    request.reasoning?.effort === undefined && request.reasoning?.summary === undefined
      ? undefined
      : {
          openai: {
            ...(request.reasoning.effort === undefined ? {} : { reasoningEffort: request.reasoning.effort }),
            ...(request.reasoning.summary === undefined ? {} : { reasoningSummary: request.reasoning.summary }),
          },
        };

  return {
    ...(request.stream === undefined ? {} : { stream: request.stream }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.top_p === undefined ? {} : { topP: request.top_p }),
    ...(request.max_output_tokens === undefined ? {} : { maxOutputTokens: request.max_output_tokens }),
    ...(request.parallel_tool_calls === undefined ? {} : { parallelToolCalls: request.parallel_tool_calls }),
    ...(request.tool_choice === undefined ? {} : { toolChoice: request.tool_choice }),
    ...(request.reasoning?.summary === undefined ? {} : { reasoningSummary: request.reasoning.summary }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
  };
}

function textContent(content: OpenAIResponsesInputMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content.map((part) => part.text).join("");
}

function textModelContent(content: OpenAIResponsesInputMessage["content"]): string | TextPart[] {
  if (typeof content === "string") {
    return content;
  }

  return content.map((part) => ({ type: "text", text: part.text }));
}
