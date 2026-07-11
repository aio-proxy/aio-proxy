import type { ModelMessage } from "../ai-sdk-bridge";
import { OpenAIResponsesTransformError } from "../error";
import type {
  OpenAIResponsesInputMessage,
  OpenAIResponsesRequest,
  OpenAIResponsesTextPart,
  OpenAIResponsesTool,
} from "../ingress/openai-responses";
import type { OpenAIResponsesFromModelMessages, OpenAIResponsesTransformTool } from "./openai-responses-types";

type UserMessage = Extract<ModelMessage, { role: "user" }>;
type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type ResponsesContentInput = UserMessage["content"] | AssistantMessage["content"];

export function modelMessagesToOpenAIResponses({
  model,
  messages,
  tools,
  settings,
}: OpenAIResponsesFromModelMessages): OpenAIResponsesRequest {
  if (model === "") {
    throw new OpenAIResponsesTransformError("model");
  }

  const reasoningEffort = settings.reasoning ?? settings.providerOptions?.openai.reasoningEffort;
  const reasoningSummary = settings.reasoningSummary ?? settings.providerOptions?.openai.reasoningSummary;

  return {
    model,
    input: messages.map((message, messageIndex) => responsesMessage(message, messageIndex)),
    ...(tools === undefined ? {} : { tools: tools.map(responsesTool) }),
    ...(settings.stream === undefined ? {} : { stream: settings.stream }),
    ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
    ...(settings.topP === undefined ? {} : { top_p: settings.topP }),
    ...(settings.maxOutputTokens === undefined ? {} : { max_output_tokens: settings.maxOutputTokens }),
    ...(settings.parallelToolCalls === undefined ? {} : { parallel_tool_calls: settings.parallelToolCalls }),
    ...(settings.toolChoice === undefined ? {} : { tool_choice: settings.toolChoice }),
    ...(reasoningEffort === undefined && reasoningSummary === undefined
      ? {}
      : {
          reasoning: {
            ...(reasoningEffort === undefined ? {} : { effort: reasoningEffort }),
            ...(reasoningSummary === undefined ? {} : { summary: reasoningSummary }),
          },
        }),
  };
}

function responsesMessage(message: ModelMessage, messageIndex: number): OpenAIResponsesInputMessage {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return {
        role: "user",
        content: responsesContent(message.content, "input_text"),
      };
    case "assistant":
      return {
        role: "assistant",
        content: responsesContent(message.content, "output_text"),
      };
    case "tool":
      throw new OpenAIResponsesTransformError(`messages.${messageIndex}.role`);
  }
}

function responsesContent(
  content: ResponsesContentInput,
  type: OpenAIResponsesTextPart["type"],
): string | OpenAIResponsesTextPart[] {
  if (typeof content === "string") {
    return content;
  }

  return content.flatMap((part) => (part.type === "text" ? [{ type, text: part.text }] : []));
}

function responsesTool(tool: OpenAIResponsesTransformTool): OpenAIResponsesTool {
  switch (tool.type) {
    case "function":
      return {
        type: "function",
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.inputSchema === undefined ? {} : { parameters: tool.inputSchema }),
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
