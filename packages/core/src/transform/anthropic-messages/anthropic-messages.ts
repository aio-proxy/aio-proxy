import type { FilePart } from "../../ai-sdk-bridge";
import type {
  AnthropicAssistantContentBlock,
  AnthropicImageBlock,
  AnthropicMessagesRequest,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "../../ingress/anthropic-messages";
import type {
  AnthropicAssistantMessage,
  AnthropicMessagesFromModelMessages,
  AnthropicMessagesModelMessages,
  AnthropicProviderOptions,
  AnthropicUserMessage,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "./types";

import { AnthropicMessagesTransformError } from "../../error";
import { convertAnthropicMessagesToModelMessages } from "./to-model";

export type {
  AnthropicMessagesFromModelMessages,
  AnthropicMessagesModelMessages,
  AnthropicModelMessage,
} from "./types";

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
          case "file":
            return imageBlock(part, `${path}.${index}`);
          case "tool-result":
            return toolResultBlock(part, `${path}.${index}`);
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

function toolResultBlock(part: ToolResultPart, path: string): AnthropicToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: part.toolCallId,
    content:
      part.output.type === "text"
        ? part.output.value
        : part.output.value.map((contentPart, index) =>
            contentPart.type === "text"
              ? { type: "text" as const, text: contentPart.text }
              : imageBlock(contentPart, `${path}.content.${index}`),
          ),
    ...(part.providerOptions?.anthropic.cache_control !== undefined
      ? { cache_control: part.providerOptions.anthropic.cache_control }
      : {}),
  };
}

function imageBlock(part: FilePart, path: string): AnthropicImageBlock {
  if (part.mediaType !== "image" && !part.mediaType.startsWith("image/")) {
    throw new AnthropicMessagesTransformError(`${path}.mediaType`);
  }
  const data = part.data;
  if (typeof data !== "object" || data === null || !("type" in data)) {
    throw new AnthropicMessagesTransformError(`${path}.data`);
  }
  const source =
    data.type === "url"
      ? ({ type: "url", url: data.url.toString() } as const)
      : data.type === "data" && typeof data.data === "string" && part.mediaType !== "image"
        ? ({ type: "base64", media_type: part.mediaType, data: data.data } as const)
        : undefined;
  if (source === undefined) throw new AnthropicMessagesTransformError(`${path}.data`);
  const cacheControl = (part.providerOptions as AnthropicProviderOptions | undefined)?.anthropic?.cache_control;
  return {
    type: "image",
    source,
    ...(cacheControl === undefined ? {} : { cache_control: cacheControl }),
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
