import type { ModelMessage } from "../ai-sdk-bridge";
import type { OpenAICompletionsRequest } from "../ingress/openai-completions";
import type { OpenAICompletionsFromModelMessages } from "./openai-completions";

import { OpenAICompletionsTransformError } from "../error";

export function modelMessagesToOpenAICompletions({
  model,
  messages,
  tools,
  settings,
}: OpenAICompletionsFromModelMessages): OpenAICompletionsRequest {
  return {
    model,
    messages: messages.map((message, messageIndex) => {
      switch (message.role) {
        case "system":
          return { role: "system", content: message.content };
        case "user":
          return { role: "user", content: openAIContent(message.content) };
        case "assistant": {
          const content = assistantOpenAIContent(message.content);
          const tool_calls = assistantToolCalls(message.content);

          return {
            role: "assistant",
            content,
            ...(tool_calls.length > 0 ? { tool_calls } : {}),
          };
        }
        case "tool": {
          const part = message.content[0];

          return {
            role: "tool",
            tool_call_id: part?.type === "tool-result" ? part.toolCallId : "",
            content: part?.type === "tool-result" && part.output.type === "text" ? part.output.value : "",
          };
        }
      }
      throw new OpenAICompletionsTransformError(`messages.${messageIndex}.role`);
    }),
    ...(tools === undefined
      ? {}
      : {
          tools: tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              ...(tool.inputSchema === undefined ? {} : { parameters: tool.inputSchema }),
            },
          })),
        }),
    ...(settings.stream === undefined ? {} : { stream: settings.stream }),
    ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
    ...(settings.maxTokens === undefined ? {} : { max_completion_tokens: settings.maxTokens }),
    ...(settings.responseFormat === undefined ? {} : { response_format: settings.responseFormat }),
    ...(settings.reasoning === undefined ? {} : { reasoning_effort: settings.reasoning }),
  };
}

function openAIContent(content: ModelMessage["content"]) {
  if (typeof content === "string") {
    return content;
  }

  return content.flatMap((part) => (part.type === "text" ? [{ type: "text" as const, text: part.text }] : []));
}

function assistantOpenAIContent(content: ModelMessage["content"]) {
  if (typeof content === "string") {
    return content;
  }

  const parts = openAIContent(content);
  return parts.length === 0 ? null : parts;
}

function assistantToolCalls(content: ModelMessage["content"]) {
  if (typeof content === "string") {
    return [];
  }

  return content.flatMap((part) =>
    part.type === "tool-call"
      ? [
          {
            id: part.toolCallId,
            type: "function" as const,
            function: {
              name: part.toolName,
              arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
            },
          },
        ]
      : [],
  );
}
