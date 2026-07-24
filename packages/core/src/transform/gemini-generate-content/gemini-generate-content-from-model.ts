import type { FilePart, ModelMessage } from "../../ai-sdk-bridge";
import type { GeminiGenerateContentRequest } from "../../ingress/gemini-generate-content/index";
import type {
  GeminiGenerateContentFromModelMessages,
  GeminiGenerateContentTool,
} from "./gemini-generate-content-types";

import { GeminiGenerateContentTransformError } from "../../error";
import { isImageMediaType } from "../../image-input";

type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type ToolMessage = Extract<ModelMessage, { role: "tool" }>;
type UserMessage = Extract<ModelMessage, { role: "user" }>;
type ToolPart = Extract<ToolMessage["content"][number], { type: "tool-result" }>;
type GeminiPart = GeminiGenerateContentRequest["contents"][number]["parts"][number];
type GeminiContent = GeminiGenerateContentRequest["contents"][number];
type GeminiFunctionResponse = NonNullable<GeminiPart["functionResponse"]>;
type NonContentToolOutput = Exclude<ToolPart["output"], { type: "content" }>;

export function modelMessagesToGeminiGenerateContent({
  model,
  messages,
  tools,
  settings,
}: GeminiGenerateContentFromModelMessages): GeminiGenerateContentRequest {
  if (model === "") {
    throw new GeminiGenerateContentTransformError("model");
  }

  const first = messages[0];
  const body = first?.role === "system" ? messages.slice(1) : messages;
  const safety = settings.providerOptions?.google.safetySettings ?? settings.safetySettings;

  return {
    model,
    contents: body.map(messageToContent),
    ...(first?.role === "system" ? { systemInstruction: { parts: [{ text: first.content }] } } : {}),
    ...(tools === undefined
      ? {}
      : {
          tools: [
            {
              functionDeclarations: tools.map(geminiTool),
            },
          ],
        }),
    ...(settings.generationConfig === undefined ? {} : { generationConfig: settings.generationConfig }),
    ...(safety === undefined ? {} : { safetySettings: safety }),
  };
}

function geminiTool(tool: GeminiGenerateContentTool) {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.inputSchema === undefined ? {} : { parameters: tool.inputSchema }),
  };
}

function messageToContent(message: ModelMessage, index: number): GeminiContent {
  if (message.role === "system") {
    throw new GeminiGenerateContentTransformError(`messages.${index}.role`);
  }

  if (message.role === "tool") {
    return {
      role: "user",
      parts: message.content.map((part, partIndex) => {
        if (part.type === "tool-result") {
          return functionResponsePart(part, `messages.${index}.content.${partIndex}.output`);
        }
        throw new GeminiGenerateContentTransformError(`messages.${index}.content.${partIndex}.type`);
      }),
    };
  }

  const path = `messages.${index}`;
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts:
      message.role === "assistant"
        ? assistantPartsToGemini(message.content, path)
        : userPartsToGemini(message.content, path),
  };
}

function userPartsToGemini(content: UserMessage["content"], path: string): GeminiPart[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }

  return content.map((part, index) => {
    if (part.type === "text") {
      return { text: part.text };
    }

    if (part.type === "file") return geminiFilePart(part, `${path}.content.${index}`);

    throw new GeminiGenerateContentTransformError(`${path}.content.${index}.type`);
  });
}

function assistantPartsToGemini(content: AssistantMessage["content"], path: string): GeminiPart[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }

  return content.map((part, index) => {
    if (part.type === "text") {
      return { text: part.text };
    }

    if (part.type === "tool-call") {
      return { functionCall: { id: part.toolCallId, name: part.toolName, args: part.input } };
    }

    if (part.type === "file") return geminiFilePart(part, `${path}.content.${index}`);

    throw new GeminiGenerateContentTransformError(`${path}.content.${index}.type`);
  });
}

function functionResponsePart(part: ToolPart, path: string): GeminiPart {
  const output = functionResponseOutput(part.output, path);
  return {
    functionResponse: {
      id: part.toolCallId,
      name: part.toolName,
      response: output.response,
      ...(output.parts === undefined ? {} : { parts: output.parts }),
    },
  };
}

function functionResponseOutput(
  output: ToolPart["output"],
  path: string,
): {
  readonly response: unknown;
  readonly parts?: GeminiFunctionResponse["parts"];
} {
  if (output.type !== "content") return { response: toolOutput(output) };
  const text = output.value.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  const parts = output.value.flatMap((part, index) => {
    if (part.type === "text") return [];
    if (part.type !== "file") {
      throw new GeminiGenerateContentTransformError(`${path}.value.${index}.type`);
    }
    if (part.mediaType === "image" || !isImageMediaType(part.mediaType)) {
      throw new GeminiGenerateContentTransformError(`${path}.value.${index}.mediaType`);
    }
    const data = part.data;
    if (
      typeof data !== "object" ||
      data === null ||
      !("type" in data) ||
      data.type !== "data" ||
      typeof data.data !== "string"
    ) {
      throw new GeminiGenerateContentTransformError(`${path}.value.${index}.data`);
    }
    return [{ inlineData: { mimeType: part.mediaType, data: data.data } }];
  });
  return {
    response: parseJson(text),
    ...(parts.length === 0 ? {} : { parts }),
  };
}

function geminiFilePart(part: FilePart, path: string): GeminiPart {
  const data = part.data;
  if (typeof data !== "object" || data === null || !("type" in data)) {
    throw new GeminiGenerateContentTransformError(`${path}.data`);
  }
  if (data.type === "url") {
    return { fileData: { mimeType: part.mediaType, fileUri: data.url.toString() } };
  }
  if (data.type === "data" && typeof data.data === "string") {
    return { inlineData: { mimeType: part.mediaType, data: data.data } };
  }
  if (data.type === "reference") {
    const fileUri = data.reference["google"];
    if (typeof fileUri === "string" && fileUri.length > 0) {
      return { fileData: { mimeType: part.mediaType, fileUri } };
    }
  }
  throw new GeminiGenerateContentTransformError(`${path}.data`);
}

function toolOutput(output: NonContentToolOutput): unknown {
  switch (output.type) {
    case "text":
      return parseJson(output.value);
    case "json":
      return output.value;
    case "execution-denied":
      return { error: output.reason ?? "execution denied" };
    case "error-text":
      return { error: output.value };
    case "error-json":
      return output.value;
    default:
      return assertNever(output);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return value;
    }
    throw error;
  }
}

function assertNever(value: never): never {
  throw new GeminiGenerateContentTransformError(JSON.stringify(value));
}
