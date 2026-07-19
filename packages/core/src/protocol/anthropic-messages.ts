import type { ProviderExecutedTool } from "@aio-proxy/plugin-sdk";

import { ProviderProtocol } from "@aio-proxy/types";

import type { ModelMessage } from "../ai-sdk-bridge";
import type { SessionCandidate } from "./session";

import { writeAnthropicMessagesResponse, writeAnthropicMessagesSSE } from "../egress/anthropic-messages";
import {
  type AnthropicFunctionTool,
  type AnthropicMessagesRequest,
  type AnthropicWebSearchTool,
  parseAnthropicMessages,
} from "../ingress/anthropic-messages";
import { type AnthropicModelMessage, anthropicMessagesToModelMessages } from "../transform/anthropic-messages";
import { defineProtocolAdapter, type EmptyProtocolContext } from "./adapter";
import { anthropicThinkingOption } from "./anthropic-thinking";
import { anthropicMessagesErrors } from "./errors";
import { readJsonRequest, rewriteJsonRequestModel } from "./request";
import { functionToolSet } from "./tools";

type AnthropicAssistantPart = Exclude<Extract<AnthropicModelMessage, { role: "assistant" }>["content"], string>[number];
type AnthropicUserContent = Extract<AnthropicModelMessage, { role: "user" }>["content"];
type AnthropicUserPart = Exclude<AnthropicUserContent, string>[number];
type AnthropicTextPart = Extract<AnthropicAssistantPart | AnthropicUserPart, { type: "text" }>;
type AnthropicToolResultPart = Extract<AnthropicAssistantPart | AnthropicUserPart, { type: "tool-result" }>;

export const anthropicMessagesAdapter = defineProtocolAdapter<AnthropicMessagesRequest, EmptyProtocolContext>({
  protocol: ProviderProtocol.Anthropic,
  async parse(raw) {
    const request = parseAnthropicMessages(await readJsonRequest(raw));
    anthropicThinkingOption(request);
    return request;
  },
  model: (request) => request.model,
  variant: (request) => (request.thinking?.type === "adaptive" ? request.output_config?.effort : undefined),
  session: (request) => ({
    candidates: [
      candidate("claude-code", claudeCodeSession(request.metadata?.user_id)),
      candidate("body-session", request.metadata?.session_id),
      candidate("body-conversation", request.metadata?.conversation_id),
      candidate("body-session", request.session_id),
      candidate("body-conversation", request.conversation_id),
    ].filter(isCandidate),
    transcript: request.messages,
  }),
  wantsStream: (request) => request.stream === true,
  rawRequest(raw, request, resolvedModel) {
    return request.model === resolvedModel ? Promise.resolve(raw.clone()) : rewriteJsonRequestModel(raw, resolvedModel);
  },
  modelInvocation(request) {
    const transformed = anthropicMessagesToModelMessages(request);
    const functionTools = request.tools?.filter(isFunctionTool);
    const providerTools = request.tools?.filter(isWebSearchTool).map(anthropicWebSearchTool);
    const tools = functionToolSet(
      functionTools === undefined || functionTools.length === 0
        ? undefined
        : functionTools.map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            inputSchema: tool.input_schema,
          })),
    );
    return {
      messages: aiSdkMessages(transformed.messages),
      settings: transformed.settings,
      ...(tools === undefined ? {} : { tools }),
      ...(providerTools === undefined || providerTools.length === 0 ? {} : { providerTools }),
    };
  },
  modelJson: writeAnthropicMessagesResponse,
  modelSse: writeAnthropicMessagesSSE,
  errors: anthropicMessagesErrors,
});

export function anthropicWebSearchTool(tool: AnthropicWebSearchTool): ProviderExecutedTool {
  return {
    type: "web-search",
    name: tool.name,
    ...(tool.max_uses === undefined ? {} : { maxUses: tool.max_uses }),
    ...(tool.allowed_domains === undefined || tool.allowed_domains.length === 0
      ? {}
      : { allowedDomains: tool.allowed_domains }),
    ...(tool.blocked_domains === undefined || tool.blocked_domains.length === 0
      ? {}
      : { blockedDomains: tool.blocked_domains }),
  };
}

function isFunctionTool(tool: NonNullable<AnthropicMessagesRequest["tools"]>[number]): tool is AnthropicFunctionTool {
  return tool.type === undefined;
}

function isWebSearchTool(tool: NonNullable<AnthropicMessagesRequest["tools"]>[number]): tool is AnthropicWebSearchTool {
  return tool.type !== undefined;
}

function claudeCodeSession(userId: string | undefined): string | undefined {
  if (userId === undefined) return undefined;
  const legacy = /^user_.+_account__session_(.+)$/u.exec(userId)?.[1];
  if (legacy !== undefined) return legacy;
  try {
    const parsed = JSON.parse(userId) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const sessionId = (parsed as { readonly session_id?: unknown }).session_id;
      return typeof sessionId === "string" ? sessionId : undefined;
    }
  } catch {}
  return undefined;
}

function candidate(source: SessionCandidate["source"], value: string | undefined): SessionCandidate | undefined {
  return value === undefined ? undefined : { source, value };
}

function isCandidate(value: SessionCandidate | undefined): value is SessionCandidate {
  return value !== undefined;
}

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
        return assertNever(message);
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

function assertNever(value: never): never {
  throw new Error(`Unsupported Anthropic message role: ${String(value)}`);
}
