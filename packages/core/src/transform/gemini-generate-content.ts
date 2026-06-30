import type { ModelMessage } from "ai";
import type { GeminiGenerateContentRequest } from "../ingress/gemini-generate-content";
import {
  type GeminiGenerateContentModelMessages,
  GeminiGenerateContentTransformError,
} from "./gemini-generate-content-types";

type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type ToolMessage = Extract<ModelMessage, { role: "tool" }>;
type UserMessage = Extract<ModelMessage, { role: "user" }>;
type AssistantPart = Exclude<AssistantMessage["content"], string>[number];
type ToolPart = Extract<
  ToolMessage["content"][number],
  { type: "tool-result" }
>;
type UserPart = Exclude<UserMessage["content"], string>[number];
type GeminiPart =
  GeminiGenerateContentRequest["contents"][number]["parts"][number];
type GeminiContent = GeminiGenerateContentRequest["contents"][number];

export { modelMessagesToGeminiGenerateContent } from "./gemini-generate-content-from-model";
export {
  type GeminiGenerateContentFromModelMessages,
  type GeminiGenerateContentModelMessages,
  type GeminiGenerateContentSettings,
  type GeminiGenerateContentTool,
  GeminiGenerateContentTransformError,
} from "./gemini-generate-content-types";

export function geminiGenerateContentToModelMessages(
  request: GeminiGenerateContentRequest,
): GeminiGenerateContentModelMessages {
  return {
    messages: [
      ...(request.systemInstruction === undefined
        ? []
        : [
            {
              role: "system",
              content: request.systemInstruction.parts
                .map((part) => part.text)
                .join(""),
            } satisfies ModelMessage,
          ]),
      ...request.contents.map(contentToMessage),
    ],
    tools: request.tools?.flatMap((tool) =>
      tool.functionDeclarations.map((declaration) => ({
        type: "function",
        name: declaration.name,
        ...(declaration.description === undefined
          ? {}
          : { description: declaration.description }),
        ...(declaration.parameters === undefined
          ? {}
          : { inputSchema: declaration.parameters }),
      })),
    ),
    settings: {
      generationConfig: request.generationConfig,
      safetySettings: request.safetySettings,
      providerOptions:
        request.safetySettings === undefined
          ? undefined
          : { google: { safetySettings: request.safetySettings } },
    },
  };
}

function contentToMessage(
  content: GeminiContent,
  contentIndex: number,
): ModelMessage {
  if (content.role === "model") {
    return {
      role: "assistant",
      content: content.parts.map((part, partIndex) =>
        assistantPart(part, contentIndex, partIndex),
      ),
    };
  }

  if (content.parts.every((part) => part.functionResponse !== undefined)) {
    return {
      role: "tool",
      content: content.parts.map((part, partIndex) =>
        toolResultPart(part, contentIndex, partIndex),
      ),
    };
  }

  return { role: "user", content: content.parts.map(userPart) };
}

function userPart(part: GeminiPart): UserPart {
  if (part.text !== undefined) {
    return { type: "text", text: part.text };
  }

  if (part.inlineData !== undefined) {
    return {
      type: "file",
      mediaType: part.inlineData.mimeType,
      data: { type: "data", data: part.inlineData.data },
    };
  }

  throw new GeminiGenerateContentTransformError("contents.parts");
}

function assistantPart(
  part: GeminiPart,
  contentIndex: number,
  partIndex: number,
): AssistantPart {
  if (part.text !== undefined) {
    return { type: "text", text: part.text };
  }

  if (part.functionCall !== undefined) {
    return {
      type: "tool-call",
      toolCallId: `gemini-${contentIndex}-${partIndex}`,
      toolName: part.functionCall.name,
      input: part.functionCall.args ?? {},
    };
  }

  throw new GeminiGenerateContentTransformError(
    `contents.${contentIndex}.parts.${partIndex}`,
  );
}

function toolResultPart(
  part: GeminiPart,
  contentIndex: number,
  partIndex: number,
): ToolPart {
  const response = part.functionResponse;
  if (response === undefined) {
    throw new GeminiGenerateContentTransformError(
      `contents.${contentIndex}.parts.${partIndex}`,
    );
  }

  return {
    type: "tool-result",
    toolCallId: `gemini-response-${response.name}-${contentIndex}-${partIndex}`,
    toolName: response.name,
    output: { type: "text", value: JSON.stringify(response.response) ?? "" },
  };
}
