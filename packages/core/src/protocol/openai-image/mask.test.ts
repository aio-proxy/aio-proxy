import { expect, test } from 'bun:test';

import { OpenAIImagesInvalidRequestError } from '../../error';
import type { ImageBytesRef } from '../image-adapter';
import { assertConvertMask, decodeImageBytes } from './mask';

const PNG_1X1_RGBA = Uint8Array.from(
  Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex',
  ),
);

const PNG_1X1_RGB = Uint8Array.from(
  Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c6300000002000100e5e70b0000000049454e44ae426082',
    'hex',
  ),
);

const JPEG_1X1 = Uint8Array.from(
  Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0000b080001000101011100ffd9', 'hex'),
);

const WEBP_1X1_ALPHA = Uint8Array.from(
  Buffer.from('524946461a00000057454250565038580a0000001000000000000000000000', 'hex'),
);

const WEBP_1X1_OPAQUE = Uint8Array.from(
  Buffer.from('524946461a00000057454250565038580a0000000000000000000000000000', 'hex'),
);

function bytesRef(
  overrides: Partial<ImageBytesRef> & Pick<ImageBytesRef, 'format' | 'width' | 'height' | 'hasAlpha'>,
): ImageBytesRef {
  return {
    type: 'bytes',
    mediaType: `image/${overrides.format}`,
    data: overrides.data ?? new Uint8Array(),
    byteLength: overrides.byteLength ?? overrides.data?.byteLength ?? 0,
    ...overrides,
  };
}

test('decodes PNG JPEG and WebP dimensions from bytes not Content-Type', () => {
  expect(decodeImageBytes(PNG_1X1_RGBA, 'image/jpeg')).toMatchObject({
    format: 'png',
    width: 1,
    height: 1,
    hasAlpha: true,
    byteLength: PNG_1X1_RGBA.byteLength,
  });
  expect(decodeImageBytes(PNG_1X1_RGB)).toMatchObject({ format: 'png', hasAlpha: false });
  expect(decodeImageBytes(JPEG_1X1, 'image/png')).toMatchObject({
    format: 'jpeg',
    width: 1,
    height: 1,
    hasAlpha: false,
  });
  expect(decodeImageBytes(WEBP_1X1_ALPHA)).toMatchObject({ format: 'webp', width: 1, height: 1, hasAlpha: true });
  expect(decodeImageBytes(WEBP_1X1_OPAQUE)).toMatchObject({ format: 'webp', hasAlpha: false });
});

test('undecodable bytes are 400 image', () => {
  try {
    decodeImageBytes(new Uint8Array([0, 1, 2, 3, 4]));
    throw new Error('expected decode to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(OpenAIImagesInvalidRequestError);
    expect(error).toMatchObject({ param: 'image', status: 400 });
  }
});

test('mask with shared format size and alpha passes', () => {
  const image = decodeImageBytes(PNG_1X1_RGBA);
  const mask = decodeImageBytes(PNG_1X1_RGBA);
  expect(() => assertConvertMask([image], mask)).not.toThrow();
});

test('no mask does not require images to share size or format', () => {
  const png = decodeImageBytes(PNG_1X1_RGBA);
  const jpeg = decodeImageBytes(JPEG_1X1);
  expect(() => assertConvertMask([png, jpeg])).not.toThrow();
});

test.each([
  [
    'missing alpha',
    [bytesRef({ format: 'png', width: 1, height: 1, hasAlpha: true })],
    bytesRef({ format: 'png', width: 1, height: 1, hasAlpha: false }),
  ],
  [
    'dimension mismatch',
    [bytesRef({ format: 'png', width: 2, height: 1, hasAlpha: true })],
    bytesRef({ format: 'png', width: 1, height: 1, hasAlpha: true }),
  ],
  [
    'format mismatch',
    [bytesRef({ format: 'png', width: 1, height: 1, hasAlpha: true })],
    bytesRef({ format: 'webp', width: 1, height: 1, hasAlpha: true }),
  ],
] as const)('mask %s is 400 mask', (_name, images, mask) => {
  try {
    assertConvertMask(images, mask);
    throw new Error('expected mask check to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(OpenAIImagesInvalidRequestError);
    expect(error).toMatchObject({ param: 'mask', status: 400 });
  }
});
