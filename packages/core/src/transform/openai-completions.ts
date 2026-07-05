import type { ModelMessage } from "../ai-sdk-bridge";
import { OpenAICompletionsTransformError } from "../error";
import type { OpenAICompletionsRequest } from "../ingress/openai-completions";

type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type AssistantPart = Exclude<AssistantMessage["content"], string>[number];
type TextPart = Extract<AssistantPart, { type: "text" }>;
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
  readonly reasoningEffort?: "low" | "medium" | "high";
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
          return { role: "system", content: textContent(message.content) };
        case "user":
          return { role: "user", content: modelContent(message.content) };
        case "assistant": {
          const parts: AssistantPart[] = textParts(message.content);
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
            content: parts.length === 0 ? textContent(message.content) : parts,
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
                output: { type: "text", value: textContent(message.content) },
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
      ...(req.reasoning_effort !== undefined ? { reasoningEffort: req.reasoning_effort } : {}),
    },
  };
}

function textContent(content: OpenAICompletionsRequest["messages"][number]["content"]) {
  if (typeof content === "string") {
    return content;
  }

  if (content === null) {
    return "";
  }

  return content
    .filter((part) => part.type === "text")
    .map((part) => (textKey in part && typeof part[textKey] === "string" ? part[textKey] : ""))
    .join("");
}

function modelContent(content: OpenAICompletionsRequest["messages"][number]["content"]) {
  if (typeof content === "string") {
    return content;
  }

  return textParts(content);
}

function textParts(content: OpenAICompletionsRequest["messages"][number]["content"]): TextPart[] {
  if (!Array.isArray(content)) {
    return typeof content === "string" && content !== "" ? [{ type: "text" as const, text: content }] : [];
  }

  return content.flatMap((part) =>
    part.type === "text" && textKey in part && typeof part[textKey] === "string"
      ? [{ type: "text", text: part[textKey] }]
      : [],
  );
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
