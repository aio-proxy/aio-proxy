import type { ModelMessage, TextPart } from "../ai-sdk-bridge";
import { OpenAIResponsesTransformError, OpenAIResponsesUnsupportedFeatureError } from "../error";
import type {
  OpenAIResponsesInputItem,
  OpenAIResponsesInputMessage,
  OpenAIResponsesRequest,
  OpenAIResponsesTool,
} from "../ingress/openai-responses";
import type {
  OpenAIResponsesModelMessages,
  OpenAIResponsesTransformSettings,
  OpenAIResponsesTransformTool,
} from "./openai-responses-types";

type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type AssistantPart = Exclude<AssistantMessage["content"], string>[number];
type ToolMessage = Extract<ModelMessage, { role: "tool" }>;
type ToolResultPart = Extract<ToolMessage["content"][number], { type: "tool-result" }>;
type FunctionCallOutputItem = Extract<OpenAIResponsesInputItem, { type: "function_call_output" }>;
type FunctionItemType = "function_call" | "function_call_output";

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
  if (request.store === true) throw new OpenAIResponsesUnsupportedFeatureError("store", "store");

  return {
    messages:
      typeof request.input === "string" ? [{ role: "user", content: request.input }] : inputMessages(request.input),
    ...(request.tools === undefined ? {} : { tools: request.tools.map(transformTool) }),
    settings: transformSettings(request),
  };
}

function inputMessages(items: readonly OpenAIResponsesInputItem[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const toolNames = new Map<string, string>();
  let previousType: FunctionItemType | undefined;

  for (const [index, item] of items.entries()) {
    if ("role" in item) {
      messages.push(inputMessage(item));
      previousType = undefined;
      continue;
    }

    switch (item.type) {
      case "reasoning":
        throw new OpenAIResponsesUnsupportedFeatureError("reasoning", `input.${index}.type`);
      case "function_call":
        toolNames.set(item.call_id, item.name);
        appendToolCall(messages, previousType, {
          type: "tool-call",
          toolCallId: item.call_id,
          toolName: item.name,
          input: parseArguments(item.arguments, `input.${index}.arguments`),
        });
        previousType = item.type;
        break;
      case "function_call_output": {
        const toolName = toolNames.get(item.call_id);
        if (toolName === undefined) {
          throw new OpenAIResponsesTransformError(`input.${index}.call_id`);
        }
        appendToolResult(messages, previousType, {
          type: "tool-result",
          toolCallId: item.call_id,
          toolName,
          output: functionOutput(item.output, `input.${index}.output`),
        });
        previousType = item.type;
        break;
      }
      case "item_reference":
        throw new OpenAIResponsesUnsupportedFeatureError("item_reference", `input.${index}.type`);
    }
  }

  return messages;
}

function functionOutput(output: FunctionCallOutputItem["output"], path: string): ToolResultPart["output"] {
  if (typeof output === "string") return { type: "text", value: output };

  return {
    type: "content",
    value: output.map((part, index) => {
      if (part.type === "input_text") return { type: "text", text: part.text };
      throw new OpenAIResponsesUnsupportedFeatureError(part.type, `${path}.${index}.type`);
    }),
  };
}

function appendToolCall(messages: ModelMessage[], previousType: FunctionItemType | undefined, part: AssistantPart) {
  const last = messages.at(-1);
  if (previousType === "function_call" && last?.role === "assistant" && typeof last.content !== "string") {
    messages[messages.length - 1] = { role: "assistant", content: [...last.content, part] };
    return;
  }
  messages.push({ role: "assistant", content: [part] });
}

function appendToolResult(messages: ModelMessage[], previousType: FunctionItemType | undefined, part: ToolResultPart) {
  const last = messages.at(-1);
  if (previousType === "function_call_output" && last?.role === "tool") {
    messages[messages.length - 1] = { role: "tool", content: [...last.content, part] };
    return;
  }
  messages.push({ role: "tool", content: [part] });
}

function parseArguments(value: string, path: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) throw new OpenAIResponsesTransformError(path);
    throw error;
  }
}

function inputMessage(message: OpenAIResponsesInputMessage): ModelMessage {
  switch (message.role) {
    case "system":
    case "developer":
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
    request.reasoning?.summary === undefined ? undefined : { openai: { reasoningSummary: request.reasoning.summary } };

  return {
    ...(request.stream === undefined ? {} : { stream: request.stream }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.top_p === undefined ? {} : { topP: request.top_p }),
    ...(request.max_output_tokens === undefined ? {} : { maxOutputTokens: request.max_output_tokens }),
    ...(request.parallel_tool_calls === undefined ? {} : { parallelToolCalls: request.parallel_tool_calls }),
    ...(request.tool_choice === undefined ? {} : { toolChoice: request.tool_choice }),
    ...(request.reasoning?.effort === undefined ? {} : { reasoning: request.reasoning.effort }),
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
