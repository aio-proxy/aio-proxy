import { expect, test } from 'bun:test';

import { fromBinary, toBinary } from '@bufbuild/protobuf';

import { UserMessageSchema } from '../../../gen/agent_pb';
import { createCursorUserMessage, extractV4UserText, v4UserHasImages } from './user-message';

test('joins text parts and detects images', () => {
  const content = [
    { type: 'text' as const, text: 'hello' },
    { type: 'text' as const, text: 'world' },
  ];
  expect(extractV4UserText(content)).toBe('hello\nworld');
  expect(v4UserHasImages(content)).toBe(false);
});

test('encodes an inline image into a SelectedImage data blob', () => {
  const pngBytes = new Uint8Array([1, 2, 3, 4]);
  const content = [
    { type: 'text' as const, text: 'look' },
    { type: 'file' as const, mediaType: 'image/png', data: { type: 'data' as const, data: pngBytes } },
  ];
  expect(v4UserHasImages(content)).toBe(true);
  const message = createCursorUserMessage(content, 'look', 'mid-1');
  const decoded = fromBinary(UserMessageSchema, toBinary(UserMessageSchema, message));
  expect(decoded.text).toBe('look');
  expect(decoded.messageId).toBe('mid-1');
  const image = decoded.selectedContext?.selectedImages?.[0];
  expect(image?.mimeType).toBe('image/png');
  expect(image?.dataOrBlobId.case).toBe('data');
  expect([...(image!.dataOrBlobId.value as Uint8Array)]).toEqual([1, 2, 3, 4]);
});
