import { AnthropicMessagesTransformError } from "../../error";
import type {
  AnthropicCacheControl,
  AnthropicMessagesRequest,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "../../ingress/anthropic-messages";
import { anthropicThinkingOption } from "../../protocol/anthropic-thinking";
import type {
  AnthropicAssistantMessage,
  AnthropicMessagesModelMessages,
  AnthropicMessagesSettings,
  AnthropicModelMessage,
  AnthropicProviderOptions,
  AnthropicSystemMessage,
  AnthropicUserMessage,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "./types";

export function convertAnthropicMessagesToModelMessages(
  request: AnthropicMessagesRequest,
): AnthropicMessagesModelMessages {
  const toolNames = new Map<string, string>();
  const messages: AnthropicModelMessage[] = [];
  for (const message of request.messages) messages.push(messageToModelMessage(message, toolNames));

  const settings: AnthropicMessagesSettings = {
    ...(request.stream !== undefined ? { stream: request.stream } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.max_tokens !== undefined ? { maxTokens: request.max_tokens } : {}),
  };
  const thinking = anthropicThinkingOption(request);
  return {
    messages: [...(request.system === undefined ? [] : [systemToModelMessage(request.system)]), ...messages],
    settings:
      thinking === undefined
        ? settings
        : {
            ...settings,
            providerOptions: {
              ...settings.providerOptions,
              aioProxy: { ...settings.providerOptions?.aioProxy, thinking },
            },
          },
  };
}

function messageToModelMessage(
  message: AnthropicMessagesRequest["messages"][number],
  toolNames: Map<string, string>,
): AnthropicUserMessage | AnthropicAssistantMessage {
  switch (message.role) {
    case "user":
      return { role: "user", content: userContentToModelParts(message.content, toolNames) };
    case "assistant":
      return { role: "assistant", content: assistantContentToModelParts(message.content, toolNames) };
    default:
      return assertNever(message);
  }
}

function systemToModelMessage(system: NonNullable<AnthropicMessagesRequest["system"]>): AnthropicSystemMessage {
  if (typeof system === "string") return { role: "system", content: system };
  return {
    role: "system",
    content: system.map((part) => part.text).join(""),
    providerOptions: { anthropic: { system } },
  };
}

function userContentToModelParts(
  content: Extract<AnthropicMessagesRequest["messages"][number], { role: "user" }>["content"],
  toolNames: ReadonlyMap<string, string>,
): string | readonly (TextPart | ToolResultPart)[] {
  return typeof content === "string"
    ? content
    : content.map((part) => {
        switch (part.type) {
          case "text":
            return textPart(part);
          case "tool_result":
            return toolResultPart(part, toolNames);
          default:
            return assertNever(part);
        }
      });
}

function assistantContentToModelParts(
  content: Extract<AnthropicMessagesRequest["messages"][number], { role: "assistant" }>["content"],
  toolNames: Map<string, string>,
): string | readonly (TextPart | ToolCallPart | ReasoningPart)[] {
  return typeof content === "string"
    ? content
    : content.map((part) => {
        switch (part.type) {
          case "text":
            return textPart(part);
          case "tool_use":
            toolNames.set(part.id, part.name);
            return toolCallPart(part);
          case "thinking":
            return {
              type: "reasoning",
              text: part.thinking,
              providerOptions: { anthropic: { signature: part.signature } },
            };
          default:
            return assertNever(part);
        }
      });
}

function textPart(part: AnthropicTextBlock): TextPart {
  return {
    type: "text",
    text: part.text,
    ...(part.cache_control === undefined ? {} : { providerOptions: cacheProviderOptions(part.cache_control) }),
  };
}

function toolCallPart(part: AnthropicToolUseBlock): ToolCallPart {
  return {
    type: "tool-call",
    toolCallId: part.id,
    toolName: part.name,
    input: part.input,
    ...(part.cache_control === undefined ? {} : { providerOptions: cacheProviderOptions(part.cache_control) }),
  };
}

function toolResultPart(part: AnthropicToolResultBlock, toolNames: ReadonlyMap<string, string>): ToolResultPart {
  return {
    type: "tool-result",
    toolCallId: part.tool_use_id,
    toolName: toolNames.get(part.tool_use_id) ?? "",
    output:
      typeof part.content === "string"
        ? { type: "text", value: part.content }
        : { type: "content", value: part.content.map(({ text }) => ({ type: "text", text })) },
    ...(part.cache_control === undefined ? {} : { providerOptions: cacheProviderOptions(part.cache_control) }),
  };
}

function cacheProviderOptions(cacheControl: AnthropicCacheControl): AnthropicProviderOptions {
  return { anthropic: { cache_control: cacheControl } };
}

function assertNever(value: never): never {
  throw new AnthropicMessagesTransformError(`unsupported.${String(value)}`);
}
