import type { FilePart, ModelMessage } from "../../ai-sdk-bridge";
import type { ImageInputDetail } from "../../image-input";
import type { OpenAICompletionsRequest } from "../../ingress/openai-completions";
import type { OpenAICompletionsFromModelMessages } from "./openai-completions";

import { OpenAICompletionsTransformError } from "../../error";

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
          return { role: "user", content: openAIContent(message.content, `messages.${messageIndex}.content`) };
        case "assistant": {
          const content = assistantOpenAIContent(message.content, `messages.${messageIndex}.content`);
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
            content:
              part?.type === "tool-result" ? toolContent(part, `messages.${messageIndex}.content.0.output.value`) : "",
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

function openAIContent(content: ModelMessage["content"], path: string) {
  if (typeof content === "string") return content;
  return content.flatMap((part, index) => {
    if (part.type === "text") return [{ type: "text" as const, text: part.text }];
    if (part.type === "file") return [imageUrlContent(part, `${path}.${index}`)];
    return [];
  });
}

function imageUrlContent(part: FilePart, path: string) {
  if (part.mediaType !== "image" && !part.mediaType.startsWith("image/")) {
    throw new OpenAICompletionsTransformError(`${path}.mediaType`);
  }
  const data = part.data;
  if (typeof data !== "object" || data === null || !("type" in data)) {
    throw new OpenAICompletionsTransformError(`${path}.data`);
  }
  const url =
    data.type === "url"
      ? data.url.toString()
      : data.type === "data" && typeof data.data === "string"
        ? `data:${part.mediaType};base64,${data.data}`
        : undefined;
  if (url === undefined) throw new OpenAICompletionsTransformError(`${path}.data`);
  const detail = openAIImageDetail(part);
  return {
    type: "image_url" as const,
    image_url: { url, ...(detail === undefined ? {} : { detail }) },
  };
}

function openAIImageDetail(part: FilePart): ImageInputDetail | undefined {
  const options = part.providerOptions?.openai;
  if (typeof options !== "object" || options === null || Array.isArray(options)) return undefined;
  const detail = Reflect.get(options, "imageDetail");
  return detail === "auto" || detail === "low" || detail === "high" ? detail : undefined;
}

function toolContent(
  part: Extract<Extract<ModelMessage, { role: "tool" }>["content"][number], { type: "tool-result" }>,
  path: string,
) {
  if (part.output.type === "text") return part.output.value;
  if (part.output.type === "content") {
    return part.output.value.map((value, index) => {
      if (value.type === "text") return { type: "text" as const, text: value.text };
      if (value.type === "file") return imageUrlContent(value, `${path}.${index}`);
      throw new OpenAICompletionsTransformError(`${path}.${index}.type`);
    });
  }
  return "";
}

function assistantOpenAIContent(content: ModelMessage["content"], path: string) {
  if (typeof content === "string") {
    return content;
  }

  const parts = openAIContent(content, path);
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
