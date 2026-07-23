import type { FilePart } from "../../ai-sdk-bridge";
import type { AnthropicCacheControl, AnthropicTextBlock } from "../../ingress/anthropic-messages";
import type { AnthropicThinkingOption } from "../../protocol/anthropic-thinking";

export type AnthropicProviderOptions = {
  readonly anthropic: {
    readonly cache_control?: AnthropicCacheControl;
    readonly signature?: string;
    readonly system?: AnthropicTextBlock[];
  };
};

export type TextPart = {
  readonly type: "text";
  readonly text: string;
  readonly providerOptions?: AnthropicProviderOptions;
};

export type ToolCallPart = {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly providerOptions?: AnthropicProviderOptions;
};

export type ToolResultPart = {
  readonly type: "tool-result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output:
    | { readonly type: "text"; readonly value: string }
    | {
        readonly type: "content";
        readonly value: readonly (TextPart | FilePart)[];
      };
  readonly providerOptions?: AnthropicProviderOptions;
};

export type ReasoningPart = {
  readonly type: "reasoning";
  readonly text: string;
  readonly providerOptions?: AnthropicProviderOptions;
};

export type AnthropicSystemMessage = {
  readonly role: "system";
  readonly content: string;
  readonly providerOptions?: AnthropicProviderOptions;
};

export type AnthropicUserMessage = {
  readonly role: "user";
  readonly content: string | readonly (TextPart | FilePart | ToolResultPart)[];
};

export type AnthropicAssistantMessage = {
  readonly role: "assistant";
  readonly content: string | readonly (TextPart | ToolCallPart | ToolResultPart | ReasoningPart)[];
};

type AnthropicToolMessage = { readonly role: "tool"; readonly content: readonly ToolResultPart[] };

export type AnthropicModelMessage =
  | AnthropicSystemMessage
  | AnthropicUserMessage
  | AnthropicAssistantMessage
  | AnthropicToolMessage;

export type AnthropicMessagesSettings = {
  readonly stream?: boolean;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly providerOptions?: { readonly aioProxy?: { readonly thinking?: AnthropicThinkingOption } };
};

export type AnthropicMessagesModelMessages = {
  readonly messages: readonly AnthropicModelMessage[];
  readonly settings: AnthropicMessagesSettings;
};

export type AnthropicMessagesFromModelMessages = AnthropicMessagesModelMessages & { readonly model: string };
