import type { ModelMessage } from "../../ai-sdk-bridge";
import type { GeminiGenerateContentRequest } from "../../ingress/gemini-generate-content/index";
import type { GeminiGenerateContentModelMessages } from "./gemini-generate-content-types";

import { GeminiGenerateContentTransformError } from "../../error";
import { imageFilePart, isImageMediaType, type ImageFilePart } from "../../image-input";

type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type ToolMessage = Extract<ModelMessage, { role: "tool" }>;
type UserMessage = Extract<ModelMessage, { role: "user" }>;
type AssistantPart = Exclude<AssistantMessage["content"], string>[number];
type ToolPart = Extract<ToolMessage["content"][number], { type: "tool-result" }>;
type UserPart = Exclude<UserMessage["content"], string>[number];
type GeminiPart = GeminiGenerateContentRequest["contents"][number]["parts"][number];
type GeminiContent = GeminiGenerateContentRequest["contents"][number];
type InlineData = NonNullable<GeminiPart["inlineData"]>;

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
              content: request.systemInstruction.parts.map((part) => part.text).join(""),
            } satisfies ModelMessage,
          ]),
      ...request.contents.map(contentToMessage),
    ],
    tools: request.tools?.flatMap((tool) =>
      tool.functionDeclarations.map((declaration) => ({
        type: "function",
        name: declaration.name,
        ...(declaration.description === undefined ? {} : { description: declaration.description }),
        ...(declaration.parameters === undefined ? {} : { inputSchema: declaration.parameters }),
      })),
    ),
    settings: {
      generationConfig: request.generationConfig,
      safetySettings: request.safetySettings,
      providerOptions:
        request.safetySettings === undefined ? undefined : { google: { safetySettings: request.safetySettings } },
    },
  };
}

function contentToMessage(content: GeminiContent, contentIndex: number): ModelMessage {
  if (content.role === "model") {
    return {
      role: "assistant",
      content: content.parts.map((part, partIndex) => assistantPart(part, contentIndex, partIndex)),
    };
  }

  if (content.parts.every((part) => part.functionResponse !== undefined)) {
    return {
      role: "tool",
      content: content.parts.map((part, partIndex) => toolResultPart(part, contentIndex, partIndex)),
    };
  }

  return {
    role: "user",
    content: content.parts.map((part, partIndex) => userPart(part, contentIndex, partIndex)),
  };
}

function userPart(part: GeminiPart, contentIndex: number, partIndex: number): UserPart {
  const path = `contents.${contentIndex}.parts.${partIndex}`;
  if (part.text !== undefined) {
    return { type: "text", text: part.text };
  }
  if (part.inlineData !== undefined) {
    if (isImageMediaType(part.inlineData.mimeType)) {
      return inlineDataFile(part.inlineData, `${path}.inlineData`, false);
    }
    return {
      type: "file",
      mediaType: part.inlineData.mimeType,
      data: { type: "data", data: part.inlineData.data },
    };
  }
  if (part.fileData !== undefined) {
    const image = imageFilePart({
      type: "url",
      url: part.fileData.fileUri,
      mediaType: part.fileData.mimeType,
    });
    if (image === undefined) throw new GeminiGenerateContentTransformError(`${path}.fileData`);
    return image;
  }
  throw new GeminiGenerateContentTransformError(path);
}

function assistantPart(part: GeminiPart, contentIndex: number, partIndex: number): AssistantPart {
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

  throw new GeminiGenerateContentTransformError(`contents.${contentIndex}.parts.${partIndex}`);
}

function toolResultPart(part: GeminiPart, contentIndex: number, partIndex: number): ToolPart {
  const response = part.functionResponse;
  if (response === undefined) {
    throw new GeminiGenerateContentTransformError(`contents.${contentIndex}.parts.${partIndex}`);
  }

  const text = { type: "text" as const, text: JSON.stringify(response.response) ?? "" };
  const images = (response.parts ?? []).map((responsePart, responsePartIndex) =>
    inlineDataFile(
      responsePart.inlineData,
      `contents.${contentIndex}.parts.${partIndex}.functionResponse.parts.${responsePartIndex}.inlineData`,
      true,
    ),
  );

  return {
    type: "tool-result",
    toolCallId: `gemini-response-${response.name}-${contentIndex}-${partIndex}`,
    toolName: response.name,
    output: images.length === 0 ? { type: "text", value: text.text } : { type: "content", value: [text, ...images] },
  };
}

function inlineDataFile(inlineData: InlineData, path: string, toolResult: boolean): ImageFilePart {
  const image = imageFilePart(
    { type: "base64", mediaType: inlineData.mimeType, data: inlineData.data },
    { toolResult },
  );
  if (image === undefined) throw new GeminiGenerateContentTransformError(path);
  return image;
}
