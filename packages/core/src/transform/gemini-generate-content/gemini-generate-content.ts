import type { FilePart, ModelMessage } from "../../ai-sdk-bridge";
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
type PendingToolCallIds = Map<string, string[]>;

export function geminiGenerateContentToModelMessages(
  request: GeminiGenerateContentRequest,
): GeminiGenerateContentModelMessages {
  const pendingToolCallIds: PendingToolCallIds = new Map();
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
      ...request.contents.map((content, index) => contentToMessage(content, index, pendingToolCallIds)),
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

function contentToMessage(
  content: GeminiContent,
  contentIndex: number,
  pendingToolCallIds: PendingToolCallIds,
): ModelMessage {
  if (content.role === "model") {
    return {
      role: "assistant",
      content: content.parts.map((part, partIndex) => assistantPart(part, contentIndex, partIndex, pendingToolCallIds)),
    };
  }

  if (content.parts.every((part) => part.functionResponse !== undefined)) {
    return {
      role: "tool",
      content: content.parts.map((part, partIndex) =>
        toolResultPart(part, contentIndex, partIndex, pendingToolCallIds),
      ),
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
    return inlineDataPart(part.inlineData, `${path}.inlineData`);
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

function assistantPart(
  part: GeminiPart,
  contentIndex: number,
  partIndex: number,
  pendingToolCallIds: PendingToolCallIds,
): AssistantPart {
  const path = `contents.${contentIndex}.parts.${partIndex}`;
  if (part.text !== undefined) {
    return { type: "text", text: part.text };
  }

  if (part.inlineData !== undefined) {
    return inlineDataPart(part.inlineData, `${path}.inlineData`);
  }

  if (part.fileData !== undefined) {
    const image = imageFilePart({
      type: "reference",
      provider: "google",
      id: part.fileData.fileUri,
      mediaType: part.fileData.mimeType,
    });
    if (image === undefined) throw new GeminiGenerateContentTransformError(`${path}.fileData`);
    return image;
  }

  if (part.functionCall !== undefined) {
    const toolCallId = part.functionCall.id ?? `gemini-${contentIndex}-${partIndex}`;
    const ids = pendingToolCallIds.get(part.functionCall.name);
    if (ids === undefined) pendingToolCallIds.set(part.functionCall.name, [toolCallId]);
    else ids.push(toolCallId);
    return {
      type: "tool-call",
      toolCallId,
      toolName: part.functionCall.name,
      input: part.functionCall.args ?? {},
    };
  }

  throw new GeminiGenerateContentTransformError(path);
}

function toolResultPart(
  part: GeminiPart,
  contentIndex: number,
  partIndex: number,
  pendingToolCallIds: PendingToolCallIds,
): ToolPart {
  const response = part.functionResponse;
  if (response === undefined) {
    throw new GeminiGenerateContentTransformError(`contents.${contentIndex}.parts.${partIndex}`);
  }

  const text = { type: "text" as const, text: JSON.stringify(response.response) ?? "" };
  const ids = pendingToolCallIds.get(response.name);
  const toolCallId = response.id ?? ids?.shift() ?? `gemini-response-${response.name}-${contentIndex}-${partIndex}`;
  if (response.id !== undefined) {
    const index = ids?.indexOf(response.id) ?? -1;
    if (index >= 0) ids?.splice(index, 1);
  }
  const images = (response.parts ?? []).map((responsePart, responsePartIndex) =>
    inlineDataFile(
      responsePart.inlineData,
      `contents.${contentIndex}.parts.${partIndex}.functionResponse.parts.${responsePartIndex}.inlineData`,
      true,
    ),
  );

  return {
    type: "tool-result",
    toolCallId,
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

function inlineDataPart(inlineData: InlineData, path: string): FilePart {
  if (isImageMediaType(inlineData.mimeType)) return inlineDataFile(inlineData, path, false);
  return {
    type: "file",
    mediaType: inlineData.mimeType,
    data: { type: "data", data: inlineData.data },
  };
}
