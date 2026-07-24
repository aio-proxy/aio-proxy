import type { FilePart, ModelMessage } from "../../ai-sdk-bridge";
import type { OpenAIResponsesInputMessage, OpenAIResponsesTextPart } from "../../ingress/openai-responses/index";

import { OpenAIResponsesTransformError } from "../../error";
import { openAIImageDetail } from "../../image-input";

type ResponsesPart = Exclude<OpenAIResponsesInputMessage["content"], string>[number];
type InputImagePart = Extract<ResponsesPart, { type: "input_image" }>;
type UserContent = Extract<ModelMessage, { role: "user" }>["content"];

export function userResponsesContent(content: UserContent, path: string): string | ResponsesPart[] {
  if (typeof content === "string") return content;
  return content.map((part, index) => {
    if (part.type === "text") return { type: "input_text", text: part.text };
    const file: FilePart =
      part.type === "image"
        ? {
            type: "file",
            data: part.image,
            mediaType: part.mediaType ?? "image",
            ...(part.providerOptions === undefined ? {} : { providerOptions: part.providerOptions }),
          }
        : part;
    return inputImagePart(file, `${path}.${index}`);
  });
}

export function assistantResponsesContent(
  content: string | readonly { readonly type: string; readonly text?: string }[],
): string | OpenAIResponsesTextPart[] {
  if (typeof content === "string") return content;
  return content.flatMap((part) =>
    part.type === "text" && part.text !== undefined ? [{ type: "output_text" as const, text: part.text }] : [],
  );
}

function inputImagePart(part: FilePart, path: string): InputImagePart {
  if (part.mediaType !== "image" && !part.mediaType.startsWith("image/")) {
    throw new OpenAIResponsesTransformError(`${path}.mediaType`);
  }
  const data = part.data;
  if (typeof data !== "object" || data === null || !("type" in data)) {
    throw new OpenAIResponsesTransformError(`${path}.data`);
  }
  const detail = openAIImageDetail(part);
  if (data.type === "reference") {
    const fileId = data.reference["openai"];
    if (typeof fileId !== "string" || fileId === "") throw new OpenAIResponsesTransformError(`${path}.data`);
    return { type: "input_image", file_id: fileId, ...(detail === undefined ? {} : { detail }) };
  }
  const imageUrl =
    data.type === "url"
      ? data.url.toString()
      : data.type === "data" && typeof data.data === "string" && part.mediaType !== "image"
        ? `data:${part.mediaType};base64,${data.data}`
        : undefined;
  if (imageUrl === undefined) throw new OpenAIResponsesTransformError(`${path}.data`);
  return { type: "input_image", image_url: imageUrl, ...(detail === undefined ? {} : { detail }) };
}
