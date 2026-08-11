import { Buffer } from 'node:buffer';

import type { LanguageModelV4FilePart, LanguageModelV4TextPart } from '@ai-sdk/provider';
import { create } from '@bufbuild/protobuf';

import { SelectedContextSchema, SelectedImageSchema, type UserMessage, UserMessageSchema } from '../../../gen/agent_pb';

type UserContentPart = LanguageModelV4TextPart | LanguageModelV4FilePart;

export function extractV4UserText(content: readonly UserContentPart[]): string {
  return content
    .filter((part): part is LanguageModelV4TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export function v4UserHasImages(content: readonly UserContentPart[]): boolean {
  return content.some((part) => part.type === 'file' && isImageMediaType(part.mediaType));
}

export function createCursorUserMessage(
  content: readonly UserContentPart[],
  text: string,
  messageId: string = crypto.randomUUID(),
): UserMessage {
  const images = extractV4Images(content);
  return create(UserMessageSchema, {
    text,
    messageId,
    ...(images.length > 0 ? { selectedContext: create(SelectedContextSchema, { selectedImages: images }) } : {}),
  });
}

function extractV4Images(content: readonly UserContentPart[]) {
  const images: ReturnType<typeof create<typeof SelectedImageSchema>>[] = [];
  for (const part of content) {
    if (part.type !== 'file' || !isImageMediaType(part.mediaType) || part.data.type !== 'data') {
      continue;
    }
    const bytes =
      part.data.data instanceof Uint8Array ? part.data.data : Uint8Array.from(Buffer.from(part.data.data, 'base64'));
    images.push(
      create(SelectedImageSchema, {
        uuid: crypto.randomUUID(),
        mimeType: part.mediaType,
        dataOrBlobId: { case: 'data', value: bytes },
      }),
    );
  }
  return images;
}

function isImageMediaType(mediaType: string): boolean {
  return mediaType === 'image' || mediaType.startsWith('image/');
}
