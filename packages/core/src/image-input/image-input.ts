import { ProviderProtocol } from "@aio-proxy/types";

import type { FilePart, ModelMessage } from "../ai-sdk-bridge";

import { ImageInputUnsupportedError } from "../error";

export type ImageInputDetail = "auto" | "low" | "high";

export type ImageFileSource =
  | { readonly type: "base64"; readonly mediaType: string; readonly data: string }
  | { readonly type: "url"; readonly url: string; readonly mediaType?: string }
  | { readonly type: "reference"; readonly provider: string; readonly id: string; readonly mediaType?: string };

export type ImageFilePartOptions = {
  readonly detail?: ImageInputDetail;
  readonly toolResult?: boolean;
};

const fullImageMediaType = /^image\/[A-Za-z0-9!#$&^_.+-]+$/u;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const dataImageUrl = /^data:(image\/[A-Za-z0-9!#$&^_.+-]+);base64,([^,]+)$/u;

export function isValidBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && base64.test(value);
}

export function isImageMediaType(value: string): boolean {
  return value === "image" || fullImageMediaType.test(value);
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname !== "" && (url.protocol === "http:" || url.protocol === "https:");
  } catch {
    return false;
  }
}

export function imageFilePart(source: ImageFileSource, options: ImageFilePartOptions = {}): FilePart | undefined {
  const normalized = normalizeSource(source);
  if (normalized === undefined) return undefined;
  const providerOptions = {
    ...(options.detail === undefined ? {} : { openai: { imageDetail: options.detail } }),
    ...(options.toolResult === true ? { aioProxy: { toolImage: true as const } } : {}),
  };
  return {
    type: "file",
    mediaType: normalized.mediaType,
    data: normalized.data,
    ...(Object.keys(providerOptions).length === 0 ? {} : { providerOptions }),
  };
}

function normalizeSource(source: ImageFileSource): Pick<FilePart, "data" | "mediaType"> | undefined {
  if (source.type === "base64") {
    if (!fullImageMediaType.test(source.mediaType) || !isValidBase64(source.data)) return undefined;
    return { mediaType: source.mediaType, data: { type: "data", data: source.data } };
  }
  if (source.type === "reference") {
    const mediaType = source.mediaType ?? "image";
    if (source.provider === "" || source.id === "" || !isImageMediaType(mediaType)) return undefined;
    return {
      mediaType,
      data: { type: "reference", reference: { [source.provider]: source.id } },
    };
  }
  const match = dataImageUrl.exec(source.url);
  if (match !== null) {
    const mediaType = match[1];
    const data = match[2];
    if (mediaType === undefined || data === undefined || !isValidBase64(data)) return undefined;
    return { mediaType, data: { type: "data", data } };
  }
  const mediaType = source.mediaType ?? "image";
  if (!isHttpUrl(source.url) || !isImageMediaType(mediaType)) return undefined;
  return { mediaType, data: { type: "url", url: new URL(source.url) } };
}

export function imageTargetProtocolForPackage(packageName: string): ProviderProtocol | undefined {
  switch (packageName) {
    case "@ai-sdk/openai":
      return ProviderProtocol.OpenAIResponse;
    case "@ai-sdk/openai-compatible":
      return ProviderProtocol.OpenAICompatible;
    case "@ai-sdk/anthropic":
      return ProviderProtocol.Anthropic;
    case "@ai-sdk/google":
      return ProviderProtocol.Gemini;
    default:
      return undefined;
  }
}

export function assertImageInputSupported(
  messages: readonly ModelMessage[],
  targetProtocol: ProviderProtocol | undefined,
): void {
  for (const [messageIndex, message] of messages.entries()) {
    if (typeof message.content === "string") continue;
    for (const [partIndex, part] of message.content.entries()) {
      const path = `messages.${messageIndex}.content.${partIndex}`;
      if (part.type === "file" && isImageMediaType(part.mediaType)) {
        assertFileSupported(part, targetProtocol, path, false);
      }
      if (part.type === "tool-result" && part.output.type === "content") {
        for (const [outputIndex, outputPart] of part.output.value.entries()) {
          if (outputPart.type === "file" && isImageMediaType(outputPart.mediaType)) {
            assertFileSupported(outputPart, targetProtocol, `${path}.output.value.${outputIndex}`, true);
          }
        }
      }
    }
  }
}

function assertFileSupported(
  part: FilePart,
  targetProtocol: ProviderProtocol | undefined,
  path: string,
  toolResult: boolean,
): void {
  const data = part.data;
  if (typeof data !== "object" || data === null || !("type" in data)) return;
  if (data.type === "reference") {
    const openAIReference =
      targetProtocol === ProviderProtocol.OpenAIResponse &&
      typeof data.reference["openai"] === "string" &&
      data.reference["openai"].length > 0;
    if (!openAIReference || toolResult) throw new ImageInputUnsupportedError("provider-reference", path);
    return;
  }
  if (!toolResult) return;
  if (targetProtocol === undefined) throw new ImageInputUnsupportedError("unknown-target", path);
  if (targetProtocol === ProviderProtocol.Gemini && data.type === "url") {
    throw new ImageInputUnsupportedError("gemini-tool-url", path);
  }
}
