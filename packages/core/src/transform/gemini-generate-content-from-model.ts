import type { FilePart, ModelMessage } from "../ai-sdk-bridge";
import { GeminiGenerateContentTransformError } from "../error";
import type { GeminiGenerateContentRequest } from "../ingress/gemini-generate-content";
import type {
  GeminiGenerateContentFromModelMessages,
  GeminiGenerateContentTool,
} from "./gemini-generate-content-types";

type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type ToolMessage = Extract<ModelMessage, { role: "tool" }>;
type UserMessage = Extract<ModelMessage, { role: "user" }>;
type ToolPart = Extract<
  ToolMessage["content"][number],
  { type: "tool-result" }
>;
type GeminiPart =
  GeminiGenerateContentRequest["contents"][number]["parts"][number];
type GeminiContent = GeminiGenerateContentRequest["contents"][number];

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
  const safety =
    settings.providerOptions?.google.safetySettings ?? settings.safetySettings;

  return {
    model,
    contents: body.map(messageToContent),
    ...(first?.role === "system"
      ? { systemInstruction: { parts: [{ text: first.content }] } }
      : {}),
    ...(tools === undefined
      ? {}
      : {
          tools: [
            {
              functionDeclarations: tools.map(geminiTool),
            },
          ],
        }),
    ...(settings.generationConfig === undefined
      ? {}
      : { generationConfig: settings.generationConfig }),
    ...(safety === undefined ? {} : { safetySettings: safety }),
  };
}

function geminiTool(tool: GeminiGenerateContentTool) {
  return {
    name: tool.name,
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
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
          return functionResponsePart(part);
        }
        throw new GeminiGenerateContentTransformError(
          `messages.${index}.content.${partIndex}.type`,
        );
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

function userPartsToGemini(
  content: UserMessage["content"],
  path: string,
): GeminiPart[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }

  return content.map((part, index) => {
    if (part.type === "text") {
      return { text: part.text };
    }

    if (part.type === "file") {
      return {
        inlineData: {
          mimeType: part.mediaType,
          data: fileData(part, `${path}.content.${index}.data`),
        },
      };
    }

    throw new GeminiGenerateContentTransformError(
      `${path}.content.${index}.type`,
    );
  });
}

function assistantPartsToGemini(
  content: AssistantMessage["content"],
  path: string,
): GeminiPart[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }

  return content.map((part, index) => {
    if (part.type === "text") {
      return { text: part.text };
    }

    if (part.type === "tool-call") {
      return { functionCall: { name: part.toolName, args: part.input } };
    }

    throw new GeminiGenerateContentTransformError(
      `${path}.content.${index}.type`,
    );
  });
}

function functionResponsePart(part: ToolPart): GeminiPart {
  return {
    functionResponse: {
      name: part.toolName,
      response: toolOutput(part),
    },
  };
}

function fileData(part: FilePart, path: string): string {
  if (typeof part.data === "string") {
    return part.data;
  }

  if ("type" in part.data && part.data.type === "data") {
    const data = part.data.data;
    if (typeof data === "string") {
      return data;
    }
  }

  throw new GeminiGenerateContentTransformError(path);
}

function toolOutput(part: ToolPart): unknown {
  switch (part.output.type) {
    case "text":
      return parseJson(part.output.value);
    case "json":
      return part.output.value;
    case "execution-denied":
      return { error: part.output.reason ?? "execution denied" };
    case "error-text":
      return { error: part.output.value };
    case "error-json":
      return part.output.value;
    case "content":
      return part.output.value;
    default:
      return assertNever(part.output);
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
