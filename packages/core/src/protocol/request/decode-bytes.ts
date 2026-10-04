import { promisify } from 'node:util';
import { brotliDecompress, gunzip, inflate, inflateRaw, zstdDecompress } from 'node:zlib';

import type { ContentEncoding } from './content-encoding';
import {
  errorCode,
  isCompressedDataError,
  InvalidCompressedRequestBodyError,
  RequestBodyTooLargeError,
} from './errors';

const brotliDecompressAsync = promisify(brotliDecompress);
const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const inflateRawAsync = promisify(inflateRaw);
const zstdDecompressAsync = promisify(zstdDecompress);

export async function decodeRequestBytes(
  encoded: Uint8Array,
  encoding: ContentEncoding,
  maxOutputLength: number,
): Promise<Uint8Array> {
  try {
    switch (encoding) {
      case 'br':
        return await brotliDecompressAsync(encoded, { maxOutputLength });
      case 'deflate':
        return await inflateDeflate(encoded, maxOutputLength);
      case 'gzip':
      case 'x-gzip':
        return await gunzipAsync(encoded, { maxOutputLength });
      case 'zstd':
        return await zstdDecompressAsync(encoded, { maxOutputLength });
    }
  } catch (error) {
    if (errorCode(error) === 'ERR_BUFFER_TOO_LARGE') {
      throw new RequestBodyTooLargeError('Request body too large');
    }
    if (isCompressedDataError(error)) {
      throw new InvalidCompressedRequestBodyError('Invalid compressed request body');
    }
    throw error;
  }
}

async function inflateDeflate(encoded: Uint8Array, maxOutputLength: number): Promise<Uint8Array> {
  try {
    return await inflateAsync(encoded, { maxOutputLength });
  } catch (error) {
    if (errorCode(error) !== 'Z_DATA_ERROR') throw error;
    return inflateRawAsync(encoded, { maxOutputLength });
  }
}
