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

function indexOfAscii(data: Uint8Array, value: string): number {
  const needle = Buffer.from(value);
  const index = Buffer.from(data).indexOf(needle);
  if (index < 0) throw new Error(`missing ${value}`);
  return index;
}

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

test('JPEG fill bytes before a segment marker still reach SOF', () => {
  const sof = JPEG_1X1.indexOf(0xc0);
  expect(JPEG_1X1[sof - 1]).toBe(0xff);
  const filled = new Uint8Array(JPEG_1X1.length + 1);
  filled.set(JPEG_1X1.subarray(0, sof));
  filled[sof] = 0xff;
  filled.set(JPEG_1X1.subarray(sof), sof + 1);
  expect(decodeImageBytes(filled)).toMatchObject({ format: 'jpeg', width: 1, height: 1 });
});

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

test('PNG chunk lengths with the high bit set do not stall the decoder', () => {
  const iend = indexOfAscii(PNG_1X1_RGB, 'IEND');
  const prefix = PNG_1X1_RGB.subarray(0, iend - 4);
  const stalled = new Uint8Array(prefix.length + 8);
  stalled.set(prefix);
  stalled.set([0xff, 0xff, 0xff, 0xf4, 0x61, 0x61, 0x61, 0x61], prefix.length);
  expect(decodeImageBytes(stalled)).toMatchObject({ format: 'png', hasAlpha: false });
});

test('WebP chunk sizes with the high bit set do not stall the decoder', () => {
  const stalled = Uint8Array.from(Buffer.from('524946461a0000005745425061616161f4ffffff', 'hex'));
  try {
    decodeImageBytes(stalled);
    throw new Error('expected decode to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(OpenAIImagesInvalidRequestError);
    expect(error).toMatchObject({ param: 'image', status: 400 });
  }
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
