import { ProviderProtocol } from "@aio-proxy/types";
import type { ModelMessage } from "../ai-sdk-bridge";
import { writeAnthropicMessagesResponse, writeAnthropicMessagesSSE } from "../egress/anthropic-messages";
import { type AnthropicMessagesRequest, parseAnthropicMessages } from "../ingress/anthropic-messages";
import { type AnthropicModelMessage, anthropicMessagesToModelMessages } from "../transform/anthropic-messages";
import { defineProtocolAdapter, type EmptyProtocolContext } from "./adapter";
import { anthropicMessagesErrors } from "./errors";
import { readJsonRequest, rewriteJsonRequestModel } from "./request";

type AnthropicAssistantPart = Exclude<Extract<AnthropicModelMessage, { role: "assistant" }>["content"], string>[number];
type AnthropicUserContent = Extract<AnthropicModelMessage, { role: "user" }>["content"];
type AnthropicUserPart = Exclude<AnthropicUserContent, string>[number];
type AnthropicTextPart = Extract<AnthropicAssistantPart | AnthropicUserPart, { type: "text" }>;
type AnthropicToolResultPart = Extract<AnthropicAssistantPart | AnthropicUserPart, { type: "tool-result" }>;

export const anthropicMessagesAdapter = defineProtocolAdapter<AnthropicMessagesRequest, EmptyProtocolContext>({
  protocol: ProviderProtocol.Anthropic,
  async parse(raw) {
    return parseAnthropicMessages(await readJsonRequest(raw));
  },
  model: (request) => request.model,
  wantsStream: (request) => request.stream === true,
  rawRequest(raw, request, resolvedModel) {
    return request.model === resolvedModel ? Promise.resolve(raw.clone()) : rewriteJsonRequestModel(raw, resolvedModel);
  },
  modelInvocation(request) {
    const transformed = anthropicMessagesToModelMessages(request);
    return { messages: aiSdkMessages(transformed.messages), settings: transformed.settings };
  },
  modelJson: writeAnthropicMessagesResponse,
  modelSse: writeAnthropicMessagesSSE,
  errors: anthropicMessagesErrors,
});

function aiSdkMessages(messages: readonly AnthropicModelMessage[]): readonly ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    switch (message.role) {
      case "system":
        return [
          {
            role: "system",
            content: message.content,
            ...(message.providerOptions === undefined ? {} : { providerOptions: message.providerOptions }),
          },
        ];
      case "assistant":
        return [
          {
            role: "assistant",
            content: typeof message.content === "string" ? message.content : message.content.map(assistantPart),
          },
        ];
      case "tool":
        return [{ role: "tool", content: message.content.map(toolResultPart) }];
      case "user":
        return userMessages(message.content);
      default:
        throw new Error(`Unsupported Anthropic message role: ${String(message)}`);
    }
  });
}

function userMessages(content: AnthropicUserContent): ModelMessage[] {
  if (typeof content === "string") {
    return [{ role: "user", content }];
  }
  if (content.length === 0) {
    return [{ role: "user", content: [] }];
  }

  const messages: ModelMessage[] = [];
  let textParts: ReturnType<typeof textPart>[] = [];
  let toolResultParts: ReturnType<typeof toolResultPart>[] = [];

  for (const part of content) {
    if (part.type === "text") {
      if (toolResultParts.length > 0) {
        messages.push({ role: "tool", content: toolResultParts });
        toolResultParts = [];
      }
      textParts.push(textPart(part));
    } else {
      if (textParts.length > 0) {
        messages.push({ role: "user", content: textParts });
        textParts = [];
      }
      toolResultParts.push(toolResultPart(part));
    }
  }

  if (textParts.length > 0) {
    messages.push({ role: "user", content: textParts });
  }
  if (toolResultParts.length > 0) {
    messages.push({ role: "tool", content: toolResultParts });
  }
  return messages;
}

function assistantPart(part: AnthropicAssistantPart) {
  return part.type === "tool-result" ? toolResultPart(part) : { ...part };
}

function textPart(part: AnthropicTextPart) {
  return { ...part };
}

function toolResultPart(part: AnthropicToolResultPart) {
  return {
    ...part,
    output:
      part.output.type === "text"
        ? { ...part.output }
        : { ...part.output, value: part.output.value.map((value) => ({ ...value })) },
  };
}
