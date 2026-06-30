import type { FilePart, ModelMessage } from "ai";
import type { GeminiGenerateContentRequest } from "../ingress/gemini-generate-content";

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

export type GeminiGenerateContentTool = Readonly<{
  readonly type: "function";
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}>;

export type GeminiGenerateContentSettings = Readonly<{
  readonly generationConfig?:
    | GeminiGenerateContentRequest["generationConfig"]
    | undefined;
  readonly safetySettings?:
    | GeminiGenerateContentRequest["safetySettings"]
    | undefined;
  readonly providerOptions?:
    | {
        readonly google: {
          readonly safetySettings?: GeminiGenerateContentRequest["safetySettings"];
        };
      }
    | undefined;
}>;

export type GeminiGenerateContentModelMessages = Readonly<{
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly GeminiGenerateContentTool[] | undefined;
  readonly settings: GeminiGenerateContentSettings;
}>;

export type GeminiGenerateContentFromModelMessages =
  GeminiGenerateContentModelMessages & { readonly model: string };

export class GeminiGenerateContentTransformError extends Error {
  constructor(readonly path: string) {
    super(`Invalid Gemini generateContent request at ${path}`);
    this.name = "GeminiGenerateContentTransformError";
  }
}

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
    ...(first?.role === "system"
      ? { systemInstruction: { parts: [{ text: first.content }] } }
      : {}),
    contents: body.map(messageToContent),
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
