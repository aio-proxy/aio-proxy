import type { ModelMessage } from "../../ai-sdk-bridge";
import type { OpenAICompletionsRequest } from "../../ingress/openai-completions";

import { OpenAICompletionsTransformError } from "../../error";
import { imageFilePart } from "../../image-input";

type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type AssistantPart = Exclude<AssistantMessage["content"], string>[number];
type UserMessage = Extract<ModelMessage, { role: "user" }>;
type UserPart = Exclude<UserMessage["content"], string>[number];
type ContentPart = Extract<UserPart, { type: "file" | "text" }>;
type TextPart = Extract<AssistantPart, { type: "text" }>;
type ToolMessage = Extract<ModelMessage, { role: "tool" }>;
type ToolResultPart = Extract<ToolMessage["content"][number], { type: "tool-result" }>;
const textKey = "text";

export type OpenAICompletionsTransformTool = {
  readonly type: "function";
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
};

export type OpenAICompletionsTransformSettings = {
  readonly stream?: boolean;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly responseFormat?: OpenAICompletionsRequest["response_format"];
  readonly reasoning?: OpenAICompletionsRequest["reasoning_effort"];
};

export type OpenAICompletionsModelMessages = {
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly OpenAICompletionsTransformTool[];
  readonly settings: OpenAICompletionsTransformSettings;
};

export type OpenAICompletionsFromModelMessages = OpenAICompletionsModelMessages & {
  readonly model: string;
};

export function openAICompletionsToModelMessages(req: OpenAICompletionsRequest): OpenAICompletionsModelMessages {
  const toolNames = new Map<string, string>();

  return {
    messages: req.messages.map((message, messageIndex) => {
      switch (message.role) {
        case "developer":
        case "system":
          return { role: "system", content: textContent(message.content, `messages.${messageIndex}.content`) };
        case "user":
          return { role: "user", content: modelContent(message.content, `messages.${messageIndex}.content`) };
        case "assistant": {
          const contentPath = `messages.${messageIndex}.content`;
          const parts: AssistantPart[] = textParts(message.content, contentPath);
          for (const [toolIndex, toolCall] of (message.tool_calls ?? []).entries()) {
            const toolName = toolCall.function.name;
            if (toolName === undefined || toolName === "") {
              throw new OpenAICompletionsTransformError(
                `messages.${messageIndex}.tool_calls.${toolIndex}.function.name`,
              );
            }

            toolNames.set(toolCall.id, toolName);
            parts.push({
              type: "tool-call",
              toolCallId: toolCall.id,
              toolName,
              input: parseToolInput(toolCall.function.arguments),
            });
          }

          return {
            role: "assistant",
            content: parts.length === 0 ? textContent(message.content, contentPath) : parts,
          };
        }
        case "tool":
          return {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: message.tool_call_id,
                toolName: toolNames.get(message.tool_call_id) ?? "",
                output: toolOutput(message.content, `messages.${messageIndex}.content`),
              },
            ],
          };
      }
      throw new OpenAICompletionsTransformError(`messages.${messageIndex}.role`);
    }),
    ...(req.tools !== undefined
      ? {
          tools: req.tools.map((tool) => ({
            type: "function",
            name: tool.function.name,
            ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
            ...(tool.function.parameters !== undefined ? { inputSchema: tool.function.parameters } : {}),
          })),
        }
      : {}),
    settings: {
      ...(req.stream !== undefined ? { stream: req.stream } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.max_completion_tokens !== undefined ? { maxTokens: req.max_completion_tokens } : {}),
      ...(req.max_completion_tokens === undefined && req.max_tokens !== undefined ? { maxTokens: req.max_tokens } : {}),
      ...(req.response_format !== undefined ? { responseFormat: req.response_format } : {}),
      ...(req.reasoning_effort !== undefined ? { reasoning: req.reasoning_effort } : {}),
    },
  };
}

function textContent(content: OpenAICompletionsRequest["messages"][number]["content"], path: string): string {
  if (typeof content === "string") return content;
  if (content === null) return "";
  return textParts(content, path)
    .map((part) => part.text)
    .join("");
}

function textParts(content: OpenAICompletionsRequest["messages"][number]["content"], path: string): TextPart[] {
  if (!Array.isArray(content)) {
    return typeof content === "string" && content !== "" ? [{ type: "text", text: content }] : [];
  }
  return content.flatMap((part, index) => {
    if (part.type === "text" && textKey in part && typeof part[textKey] === "string") {
      return [{ type: "text" as const, text: part[textKey] }];
    }
    if (part.type === "image_url") {
      throw new OpenAICompletionsTransformError(`${path}.${index}.type`);
    }
    return [];
  });
}

function modelContent(
  content: OpenAICompletionsRequest["messages"][number]["content"],
  path: string,
): string | ContentPart[] {
  return typeof content === "string" ? content : contentParts(content, path, false);
}

function contentParts(
  content: OpenAICompletionsRequest["messages"][number]["content"],
  path: string,
  toolResult: boolean,
): ContentPart[] {
  if (!Array.isArray(content)) {
    return typeof content === "string" && content !== "" ? [{ type: "text", text: content }] : [];
  }
  return content.flatMap((part, index) => {
    if (part.type === "text" && textKey in part && typeof part[textKey] === "string") {
      return [{ type: "text" as const, text: part[textKey] }];
    }
    if (part.type !== "image_url") return [];
    const payload = Reflect.get(part, "image_url");
    const url =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? Reflect.get(payload, "url")
        : undefined;
    const detail =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? Reflect.get(payload, "detail")
        : undefined;
    if (
      typeof url !== "string" ||
      (detail !== undefined && detail !== "auto" && detail !== "low" && detail !== "high")
    ) {
      throw new OpenAICompletionsTransformError(`${path}.${index}.image_url.url`);
    }
    const image = imageFilePart({ type: "url", url }, { ...(detail === undefined ? {} : { detail }), toolResult });
    if (image === undefined) throw new OpenAICompletionsTransformError(`${path}.${index}.image_url.url`);
    return [image];
  });
}

function toolOutput(
  content: OpenAICompletionsRequest["messages"][number]["content"],
  path: string,
): ToolResultPart["output"] {
  if (!Array.isArray(content)) return { type: "text", value: textContent(content, path) };
  const value = contentParts(content, path, true);
  if (value.every((part): part is TextPart => part.type === "text")) {
    return { type: "text", value: value.map((part) => part.text).join("") };
  }
  return { type: "content", value };
}

function parseToolInput(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return input;
    }

    throw error;
  }
}
