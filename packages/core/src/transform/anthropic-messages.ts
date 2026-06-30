import type {
  AnthropicAssistantContentBlock,
  AnthropicCacheControl,
  AnthropicMessagesRequest,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "../ingress/anthropic-messages";

type AnthropicProviderOptions = {
  readonly anthropic: {
    readonly cache_control?: AnthropicCacheControl;
    readonly signature?: string;
    readonly system?: AnthropicTextBlock[];
  };
};

type TextPart = {
  readonly type: "text";
  readonly text: string;
  readonly providerOptions?: AnthropicProviderOptions;
};

type ToolCallPart = {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly providerOptions?: AnthropicProviderOptions;
};

type ToolResultPart = {
  readonly type: "tool-result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output:
    | { readonly type: "text"; readonly value: string }
    | {
        readonly type: "content";
        readonly value: readonly {
          readonly type: "text";
          readonly text: string;
        }[];
      };
  readonly providerOptions?: AnthropicProviderOptions;
};

type ReasoningPart = {
  readonly type: "reasoning";
  readonly text: string;
  readonly providerOptions?: AnthropicProviderOptions;
};

type AnthropicSystemMessage = {
  readonly role: "system";
  readonly content: string;
  readonly providerOptions?: AnthropicProviderOptions;
};

type AnthropicUserMessage = {
  readonly role: "user";
  readonly content: string | readonly (TextPart | ToolResultPart)[];
};

type AnthropicAssistantMessage = {
  readonly role: "assistant";
  readonly content:
    | string
    | readonly (TextPart | ToolCallPart | ToolResultPart | ReasoningPart)[];
};

type AnthropicToolMessage = {
  readonly role: "tool";
  readonly content: readonly ToolResultPart[];
};

export type AnthropicModelMessage =
  | AnthropicSystemMessage
  | AnthropicUserMessage
  | AnthropicAssistantMessage
  | AnthropicToolMessage;

export type AnthropicMessagesSettings = {
  readonly stream?: boolean;
  readonly temperature?: number;
  readonly maxTokens?: number;
};

export type AnthropicMessagesModelMessages = {
  readonly messages: readonly AnthropicModelMessage[];
  readonly settings: AnthropicMessagesSettings;
};

export type AnthropicMessagesFromModelMessages =
  AnthropicMessagesModelMessages & {
    readonly model: string;
  };

export class AnthropicMessagesTransformError extends Error {
  constructor(readonly path: string) {
    super(`Invalid Anthropic Messages request at ${path}`);
    this.name = "AnthropicMessagesTransformError";
  }
}

export function anthropicMessagesToModelMessages(
  req: AnthropicMessagesRequest,
): AnthropicMessagesModelMessages {
  return {
    messages: [
      ...(req.system === undefined ? [] : [systemToModelMessage(req.system)]),
      ...req.messages.map(messageToModelMessage),
    ],
    settings: {
      ...(req.stream !== undefined ? { stream: req.stream } : {}),
      ...(req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
      ...(req.max_tokens !== undefined ? { maxTokens: req.max_tokens } : {}),
    },
  };
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
          content: userContentFromModelParts(
            message.content,
            `messages.${index}.content`,
          ),
        });
        break;
      case "assistant":
        requestMessages.push({
          role: "assistant",
          content: assistantContentFromModelParts(
            message.content,
            `messages.${index}.content`,
          ),
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
    ...(settings.maxTokens !== undefined
      ? { max_tokens: settings.maxTokens }
      : {}),
    ...(settings.temperature !== undefined
      ? { temperature: settings.temperature }
      : {}),
  };
}

function messageToModelMessage(
  message: AnthropicMessagesRequest["messages"][number],
): AnthropicUserMessage | AnthropicAssistantMessage {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: userContentToModelParts(message.content),
      } satisfies AnthropicUserMessage;
    case "assistant":
      return {
        role: "assistant",
        content: assistantContentToModelParts(message.content),
      } satisfies AnthropicAssistantMessage;
    default:
      return assertNever(message);
  }
}

function systemToModelMessage(
  system: NonNullable<AnthropicMessagesRequest["system"]>,
): AnthropicSystemMessage {
  if (typeof system === "string") {
    return { role: "system", content: system };
  }

  return {
    role: "system",
    content: system.map((part) => part.text).join(""),
    providerOptions: { anthropic: { system } },
  };
}

function userContentToModelParts(
  content: Extract<
    AnthropicMessagesRequest["messages"][number],
    { role: "user" }
  >["content"],
): string | readonly (TextPart | ToolResultPart)[] {
  return typeof content === "string"
    ? content
    : content.map((part) => {
        switch (part.type) {
          case "text":
            return textPart(part);
          case "tool_result":
            return toolResultPart(part);
          default:
            return assertNever(part);
        }
      });
}

function assistantContentToModelParts(
  content: Extract<
    AnthropicMessagesRequest["messages"][number],
    { role: "assistant" }
  >["content"],
): string | readonly (TextPart | ToolCallPart | ReasoningPart)[] {
  return typeof content === "string"
    ? content
    : content.map((part) => {
        switch (part.type) {
          case "text":
            return textPart(part);
          case "tool_use":
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

function userContentFromModelParts(
  content: AnthropicUserMessage["content"],
  path: string,
): Extract<
  AnthropicMessagesRequest["messages"][number],
  { role: "user" }
>["content"] {
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
): Extract<
  AnthropicMessagesRequest["messages"][number],
  { role: "assistant" }
>["content"] {
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

function textPart(part: AnthropicTextBlock): TextPart {
  return {
    type: "text",
    text: part.text,
    ...(part.cache_control !== undefined
      ? { providerOptions: cacheProviderOptions(part.cache_control) }
      : {}),
  };
}

function toolCallPart(part: AnthropicToolUseBlock): ToolCallPart {
  return {
    type: "tool-call",
    toolCallId: part.id,
    toolName: part.name,
    input: part.input,
    ...(part.cache_control !== undefined
      ? { providerOptions: cacheProviderOptions(part.cache_control) }
      : {}),
  };
}

function toolResultPart(part: AnthropicToolResultBlock): ToolResultPart {
  return {
    type: "tool-result",
    toolCallId: part.tool_use_id,
    toolName: "",
    output:
      typeof part.content === "string"
        ? { type: "text", value: part.content }
        : {
            type: "content",
            value: part.content.map((contentPart) => ({
              type: "text",
              text: contentPart.text,
            })),
          },
    ...(part.cache_control !== undefined
      ? { providerOptions: cacheProviderOptions(part.cache_control) }
      : {}),
  };
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

function thinkingBlock(
  part: ReasoningPart,
  path: string,
): AnthropicAssistantContentBlock {
  const signature = part.providerOptions?.anthropic.signature;
  if (signature === undefined) {
    throw new AnthropicMessagesTransformError(
      `${path}.providerOptions.anthropic.signature`,
    );
  }

  return { type: "thinking", thinking: part.text, signature };
}

function cacheProviderOptions(
  cacheControl: AnthropicCacheControl,
): AnthropicProviderOptions {
  return { anthropic: { cache_control: cacheControl } };
}

function assertNever(value: never): never {
  throw new AnthropicMessagesTransformError(`unsupported.${String(value)}`);
}
