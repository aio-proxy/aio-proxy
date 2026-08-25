import { OpenAIImagesInvalidRequestError } from '../../error';
import type { ImageBytesRef } from '../image-adapter';

export function decodeImageBytes(data: Uint8Array, _mediaType?: string): ImageBytesRef {
  const decoded = decodePng(data) ?? decodeJpeg(data) ?? decodeWebp(data);
  if (decoded === undefined) throw new OpenAIImagesInvalidRequestError('image');
  return {
    type: 'bytes',
    mediaType: `image/${decoded.format}`,
    data,
    byteLength: data.byteLength,
    ...decoded,
  };
}

export function assertConvertMask(images: readonly ImageBytesRef[], mask?: ImageBytesRef): void {
  if (mask === undefined) return;
  if (!mask.hasAlpha) throw new OpenAIImagesInvalidRequestError('mask');
  for (const image of images) {
    if (image.format !== mask.format || image.width !== mask.width || image.height !== mask.height) {
      throw new OpenAIImagesInvalidRequestError('mask');
    }
  }
}

function decodePng(data: Uint8Array): Omit<ImageBytesRef, 'type' | 'mediaType' | 'data' | 'byteLength'> | undefined {
  if (data.byteLength < 26) return undefined;
  if (data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e || data[3] !== 0x47) return undefined;
  if (data[12] !== 0x49 || data[13] !== 0x48 || data[14] !== 0x44 || data[15] !== 0x52) return undefined;
  const width = readU32BE(data, 16);
  const height = readU32BE(data, 20);
  const colorType = data[25];
  if (colorType === undefined) return undefined;
  return {
    format: 'png',
    width,
    height,
    hasAlpha: colorType === 4 || colorType === 6 || hasPngTransparency(data),
  };
}

function hasPngTransparency(data: Uint8Array): boolean {
  let offset = 8;
  while (offset + 8 <= data.byteLength) {
    const length = readU32BE(data, offset);
    const type = ascii(data, offset + 4, 4);
    if (type === 'tRNS') return true;
    if (type === 'IEND') return false;
    offset += 12 + length;
  }
  return false;
}

function decodeJpeg(data: Uint8Array): Omit<ImageBytesRef, 'type' | 'mediaType' | 'data' | 'byteLength'> | undefined {
  if (data.byteLength < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 8 < data.byteLength) {
    if (data[offset] !== 0xff) return undefined;
    const marker = data[offset + 1];
    if (marker === undefined || marker === 0xd8) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const size = ((data[offset + 2] ?? 0) << 8) | (data[offset + 3] ?? 0);
    if (isJpegSof(marker) && offset + 8 < data.byteLength) {
      const height = ((data[offset + 5] ?? 0) << 8) | (data[offset + 6] ?? 0);
      const width = ((data[offset + 7] ?? 0) << 8) | (data[offset + 8] ?? 0);
      return { format: 'jpeg', width, height, hasAlpha: false };
    }
    offset += 2 + size;
  }
  return undefined;
}

function isJpegSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function decodeWebp(data: Uint8Array): Omit<ImageBytesRef, 'type' | 'mediaType' | 'data' | 'byteLength'> | undefined {
  if (data.byteLength < 20 || ascii(data, 0, 4) !== 'RIFF' || ascii(data, 8, 4) !== 'WEBP') return undefined;
  let offset = 12;
  while (offset + 8 <= data.byteLength) {
    const type = ascii(data, offset, 4);
    const size = readU32LE(data, offset + 4);
    const payload = offset + 8;
    if (type === 'VP8X' && size >= 10 && payload + 10 <= data.byteLength) {
      const width = readU24LE(data, payload + 4) + 1;
      const height = readU24LE(data, payload + 7) + 1;
      return { format: 'webp', width, height, hasAlpha: ((data[payload] ?? 0) & 0x10) !== 0 };
    }
    if (type === 'VP8 ' && payload + 10 <= data.byteLength && data[payload + 3] === 0x9d) {
      const width = (data[payload + 6] ?? 0) | ((data[payload + 7] ?? 0) << 8);
      const height = (data[payload + 8] ?? 0) | ((data[payload + 9] ?? 0) << 8);
      return { format: 'webp', width: width & 0x3fff, height: height & 0x3fff, hasAlpha: false };
    }
    if (type === 'VP8L' && payload + 5 <= data.byteLength && data[payload] === 0x2f) {
      const bits = readU32LE(data, payload + 1);
      return {
        format: 'webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
        hasAlpha: ((bits >> 28) & 1) === 1,
      };
    }
    offset += 8 + size + (size & 1);
  }
  return undefined;
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

function readU32BE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) << 24) |
    ((data[offset + 1] ?? 0) << 16) |
    ((data[offset + 2] ?? 0) << 8) |
    (data[offset + 3] ?? 0)
  );
}

function readU32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset] ?? 0) |
    ((data[offset + 1] ?? 0) << 8) |
    ((data[offset + 2] ?? 0) << 16) |
    ((data[offset + 3] ?? 0) << 24)
  );
}

function readU24LE(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8) | ((data[offset + 2] ?? 0) << 16);
}
