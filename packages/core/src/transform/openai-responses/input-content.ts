import type { FilePart, ModelMessage } from "../../ai-sdk-bridge";
import type { OpenAIResponsesInputMessage, OpenAIResponsesToolOutputPart } from "../../ingress/openai-responses/index";
import type { OpenAIResponsesWireMetadata } from "./types";

import { OpenAIResponsesTransformError } from "../../error";
import { imageFilePart } from "../../image-input";
import { rejectOpenAIResponsesFeature, warnOpenAIResponsesDegradation, wireProviderOptions } from "./tools";

type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type AssistantPart = Exclude<AssistantMessage["content"], string>[number];
type ToolMessage = Extract<ModelMessage, { role: "tool" }>;
type ToolResultPart = Extract<ToolMessage["content"][number], { type: "tool-result" }>;
type UserMessage = Extract<ModelMessage, { role: "user" }>;
type UserPart = Exclude<UserMessage["content"], string>[number];
type MessagePart = Extract<UserPart | AssistantPart, { type: "file" | "text" }>;
type InputImagePart = Extract<OpenAIResponsesToolOutputPart, { type: "input_image" }>;

function openAIImagePart(part: InputImagePart, path: string, toolResult: boolean): FilePart {
  const image =
    part.image_url !== undefined
      ? imageFilePart(
          { type: "url", url: part.image_url },
          { ...(part.detail === undefined ? {} : { detail: part.detail }), toolResult },
        )
      : imageFilePart(
          { type: "reference", provider: "openai", id: part.file_id ?? "" },
          { ...(part.detail === undefined ? {} : { detail: part.detail }), toolResult },
        );
  if (image === undefined) {
    throw new OpenAIResponsesTransformError(`${path}.${part.image_url === undefined ? "file_id" : "image_url"}`);
  }
  return image;
}

export function inputMessage(message: OpenAIResponsesInputMessage, index: number): ModelMessage {
  const metadata: OpenAIResponsesWireMetadata | undefined =
    message.type === undefined &&
    message.id === undefined &&
    message.status === undefined &&
    message.phase === undefined &&
    message.role !== "developer"
      ? undefined
      : {
          protocol: "openai-responses",
          inputIndex: index,
          itemType: message.type ?? "message",
          ...(message.id === undefined ? {} : { itemId: message.id }),
          ...(message.status === undefined ? {} : { status: message.status }),
          ...(message.phase === undefined ? {} : { phase: message.phase }),
          wireRole: message.role,
        };
  if (message.role === "developer") {
    warnOpenAIResponsesDegradation("message.role.developer", `input.${index}.role`, "converted");
  }
  const options = metadata === undefined ? {} : { providerOptions: wireProviderOptions(metadata) };
  switch (message.role) {
    case "system":
    case "developer": {
      const content = textMessageContent(message, index);
      return {
        role: "system",
        content: typeof content === "string" ? content : content.map((part) => part.text).join(""),
        ...options,
      };
    }
    case "user":
      return { role: "user", content: messageContent(message, index), ...options };
    case "assistant":
      return { role: "assistant", content: textMessageContent(message, index), ...options };
  }
}

function messageContent(message: OpenAIResponsesInputMessage, index: number): string | MessagePart[] {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part, partIndex) => {
    const path = `input.${index}.content.${partIndex}`;
    if (part.type === "input_image") return openAIImagePart(part, path, false);
    if (!("text" in part) || typeof part.text !== "string") {
      return rejectOpenAIResponsesFeature(part.type, `${path}.type`);
    }
    if (part.annotations !== undefined || part.logprobs !== undefined) {
      warnOpenAIResponsesDegradation("message.content_metadata", path, "dropped");
    }
    return { type: "text", text: part.text };
  });
}

function textMessageContent(
  message: OpenAIResponsesInputMessage,
  index: number,
): string | { type: "text"; text: string }[] {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part, partIndex) => {
    const path = `input.${index}.content.${partIndex}`;
    if (part.type === "input_image") throw new OpenAIResponsesTransformError(`${path}.type`);
    if (!("text" in part) || typeof part.text !== "string") {
      return rejectOpenAIResponsesFeature(part.type, `${path}.type`);
    }
    if (part.annotations !== undefined || part.logprobs !== undefined) {
      warnOpenAIResponsesDegradation("message.content_metadata", path, "dropped");
    }
    return { type: "text", text: part.text };
  });
}

export function toolOutput(output: string | OpenAIResponsesToolOutputPart[], path: string): ToolResultPart["output"] {
  if (typeof output === "string") return { type: "text", value: output };
  return {
    type: "content",
    value: output.map((part, index) => {
      if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
        return { type: "text", text: part.text };
      }
      if (part.type === "input_image") return openAIImagePart(part, `${path}.${index}`, true);
      return rejectOpenAIResponsesFeature(part.type, `${path}.${index}.type`);
    }),
  };
}
