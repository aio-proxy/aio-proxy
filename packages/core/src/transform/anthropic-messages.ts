import type {
  AnthropicAssistantContentBlock,
  AnthropicMessagesRequest,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "../ingress/anthropic-messages";
import type {
  AnthropicAssistantMessage,
  AnthropicMessagesFromModelMessages,
  AnthropicMessagesModelMessages,
  AnthropicUserMessage,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "./anthropic-messages/types";

import { AnthropicMessagesTransformError } from "../error";
import { convertAnthropicMessagesToModelMessages } from "./anthropic-messages/to-model";

export type {
  AnthropicMessagesFromModelMessages,
  AnthropicMessagesModelMessages,
  AnthropicModelMessage,
} from "./anthropic-messages/types";

export function anthropicMessagesToModelMessages(req: AnthropicMessagesRequest): AnthropicMessagesModelMessages {
  return convertAnthropicMessagesToModelMessages(req);
}

export function modelMessagesToAnthropicMessages({
  model,
  messages,
  settings,
}: AnthropicMessagesFromModelMessages): AnthropicMessagesRequest {
  if (model === "") {
    throw new AnthropicMessagesTransformError("model");
  }

  let system: AnthropicMessagesRequest["system"];
  const requestMessages: AnthropicMessagesRequest["messages"] = [];

  for (const [index, message] of messages.entries()) {
    switch (message.role) {
      case "system":
        if (index !== 0) {
          throw new AnthropicMessagesTransformError(`messages.${index}.role`);
        }
        system = message.providerOptions?.anthropic.system ?? message.content;
        break;
      case "user":
        requestMessages.push({
          role: "user",
          content: userContentFromModelParts(message.content, `messages.${index}.content`),
        });
        break;
      case "assistant":
        requestMessages.push({
          role: "assistant",
          content: assistantContentFromModelParts(message.content, `messages.${index}.content`),
        });
        break;
      case "tool":
        throw new AnthropicMessagesTransformError(`messages.${index}.role`);
      default:
        assertNever(message);
    }
  }

  return {
    model,
    ...(system !== undefined ? { system } : {}),
    messages: requestMessages,
    ...(settings.stream !== undefined ? { stream: settings.stream } : {}),
    ...(settings.maxTokens !== undefined ? { max_tokens: settings.maxTokens } : {}),
    ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
  };
}

function userContentFromModelParts(
  content: AnthropicUserMessage["content"],
  path: string,
): Extract<AnthropicMessagesRequest["messages"][number], { role: "user" }>["content"] {
  return typeof content === "string"
    ? content
    : content.map((part, index) => {
        switch (part.type) {
          case "text":
            return textBlock(part);
          case "tool-result":
            return toolResultBlock(part);
          default:
            throw new AnthropicMessagesTransformError(`${path}.${index}.type`);
        }
      });
}

function assistantContentFromModelParts(
  content: AnthropicAssistantMessage["content"],
  path: string,
): Extract<AnthropicMessagesRequest["messages"][number], { role: "assistant" }>["content"] {
  return typeof content === "string"
    ? content
    : content.map((part, index) => {
        switch (part.type) {
          case "text":
            return textBlock(part);
          case "tool-call":
            return toolUseBlock(part);
          case "reasoning":
            return thinkingBlock(part, `${path}.${index}`);
          case "tool-result":
            throw new AnthropicMessagesTransformError(`${path}.${index}.type`);
          default:
            return assertNever(part);
        }
      });
}

function textBlock(part: TextPart): AnthropicTextBlock {
  return {
    type: "text",
    text: part.text,
    ...(part.providerOptions?.anthropic.cache_control !== undefined
      ? { cache_control: part.providerOptions.anthropic.cache_control }
      : {}),
  };
}

function toolUseBlock(part: ToolCallPart): AnthropicToolUseBlock {
  return {
    type: "tool_use",
    id: part.toolCallId,
    name: part.toolName,
    input: part.input,
    ...(part.providerOptions?.anthropic.cache_control !== undefined
      ? { cache_control: part.providerOptions.anthropic.cache_control }
      : {}),
  };
}

function toolResultBlock(part: ToolResultPart): AnthropicToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: part.toolCallId,
    content:
      part.output.type === "text"
        ? part.output.value
        : part.output.value.map((contentPart) => ({
            type: "text",
            text: contentPart.text,
          })),
    ...(part.providerOptions?.anthropic.cache_control !== undefined
      ? { cache_control: part.providerOptions.anthropic.cache_control }
      : {}),
  };
}

function thinkingBlock(part: ReasoningPart, path: string): AnthropicAssistantContentBlock {
  const signature = part.providerOptions?.anthropic.signature;
  if (signature === undefined) {
    throw new AnthropicMessagesTransformError(`${path}.providerOptions.anthropic.signature`);
  }

  return { type: "thinking", thinking: part.text, signature };
}

function assertNever(value: never): never {
  throw new AnthropicMessagesTransformError(`unsupported.${String(value)}`);
}
