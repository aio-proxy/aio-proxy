import { createToolImageMarker } from "@aio-proxy/plugin-sdk/openai-stream";
import { ProviderProtocol } from "@aio-proxy/types";

import type { FilePart, ModelMessage } from "../ai-sdk-bridge";

import { ImageInputUnsupportedError } from "../error";

type FileData = Extract<FilePart["data"], { type: string }>;

export type ImageInputDetail = "auto" | "low" | "high";

export type ImageFileSource =
  | { readonly type: "base64"; readonly mediaType: string; readonly data: string }
  | { readonly type: "url"; readonly url: string; readonly mediaType?: string }
  | { readonly type: "reference"; readonly provider: string; readonly id: string; readonly mediaType?: string };

export type ImageFilePartOptions = {
  readonly detail?: ImageInputDetail;
  readonly toolResult?: boolean;
};

/** Tagged FilePart produced by image constructors; `data` is always FileData (not bare shorthand). */
export type ImageFilePart = {
  readonly type: "file";
  readonly mediaType: string;
  readonly data: FileData;
  readonly providerOptions?: Exclude<FilePart["providerOptions"], undefined>;
};

const fullImageMediaType = /^image\/[A-Za-z0-9!#$&^_.+-]+$/u;
const dataImageUrl = /^data:(image\/[A-Za-z0-9!#$&^_.+-]+);base64,([^,]+)$/u;

export function isValidBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let index = 0; index < value.length - padding; index += 1) {
    const code = value.charCodeAt(index);
    const isAlphabet =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 43 ||
      code === 47;
    if (!isAlphabet) return false;
  }
  return true;
}

export function isImageMediaType(value: string): boolean {
  return value === "image" || fullImageMediaType.test(value);
}

export function openAIImageDetail(part: FilePart): ImageInputDetail | undefined {
  const options = part.providerOptions?.["openai"];
  if (typeof options !== "object" || options === null || Array.isArray(options)) return undefined;
  const detail = Reflect.get(options, "imageDetail");
  return detail === "auto" || detail === "low" || detail === "high" ? detail : undefined;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname !== "" && (url.protocol === "http:" || url.protocol === "https:");
  } catch {
    return false;
  }
}

export function imageFilePart(source: ImageFileSource, options: ImageFilePartOptions = {}): ImageFilePart | undefined {
  const normalized = normalizeSource(source);
  if (normalized === undefined) return undefined;
  const providerOptions = {
    ...(options.detail === undefined ? {} : { openai: { imageDetail: options.detail } }),
    ...(options.toolResult === true ? { aioProxy: createToolImageMarker() } : {}),
  };
  return {
    type: "file",
    mediaType: normalized.mediaType,
    data: normalized.data,
    ...(Object.keys(providerOptions).length === 0 ? {} : { providerOptions }),
  };
}

function normalizeSource(source: ImageFileSource): { readonly data: FileData; readonly mediaType: string } | undefined {
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
  if (!isHttpUrl(source.url)) return undefined;
  const url = new URL(source.url);
  const inferredMediaType = Bun.file(url.pathname).type;
  const mediaType = source.mediaType ?? (fullImageMediaType.test(inferredMediaType) ? inferredMediaType : "image");
  if (!isImageMediaType(mediaType)) return undefined;
  return { mediaType, data: { type: "url", url } };
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
        assertFileSupported(part, targetProtocol, path, message.role === "assistant" ? "assistant" : "user");
      }
      if (part.type === "tool-result" && part.output.type === "content") {
        for (const [outputIndex, outputPart] of part.output.value.entries()) {
          if (outputPart.type === "file" && isImageMediaType(outputPart.mediaType)) {
            assertFileSupported(outputPart, targetProtocol, `${path}.output.value.${outputIndex}`, "tool-result");
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
  context: "assistant" | "tool-result" | "user",
): void {
  if (openAIImageDetail(part) !== undefined && targetProtocol !== ProviderProtocol.OpenAIResponse) {
    throw new ImageInputUnsupportedError("image-detail", path);
  }
  if (context === "assistant" && targetProtocol !== ProviderProtocol.Gemini) {
    throw new ImageInputUnsupportedError("assistant-image", path);
  }
  const data = part.data;
  if (typeof data !== "object" || data === null || !("type" in data)) return;
  if (context === "assistant" && data.type === "url") {
    throw new ImageInputUnsupportedError("gemini-assistant-url", path);
  }
  if (data.type === "reference") {
    const providerReference =
      context !== "tool-result" &&
      ((targetProtocol === ProviderProtocol.OpenAIResponse &&
        typeof data.reference["openai"] === "string" &&
        data.reference["openai"].length > 0) ||
        (targetProtocol === ProviderProtocol.Gemini &&
          typeof data.reference["google"] === "string" &&
          data.reference["google"].length > 0));
    if (!providerReference) throw new ImageInputUnsupportedError("provider-reference", path);
    return;
  }
  if (context === "tool-result" && targetProtocol === undefined && data.type === "url") {
    throw new ImageInputUnsupportedError("unknown-target", path);
  }
  if (context === "tool-result" && targetProtocol === ProviderProtocol.Gemini && data.type === "url") {
    throw new ImageInputUnsupportedError("gemini-tool-url", path);
  }
  if (targetProtocol === ProviderProtocol.Gemini && data.type === "url" && part.mediaType === "image") {
    throw new ImageInputUnsupportedError("gemini-url-mime", path);
  }
}
