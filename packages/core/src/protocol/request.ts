import { promisify } from 'node:util';
import {
  brotliDecompress,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createInflateRaw,
  createZstdDecompress,
  gunzip,
  inflate,
  inflateRaw,
  zstdDecompress,
  type BrotliDecompress,
  type Gunzip,
  type Inflate,
  type InflateRaw,
  type ZstdDecompress,
} from 'node:zlib';

import { z } from 'zod';

const jsonObjectSchema = z.object({}).catchall(z.unknown());
const brotliDecompressAsync = promisify(brotliDecompress);
const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const inflateRawAsync = promisify(inflateRaw);
const zstdDecompressAsync = promisify(zstdDecompress);

export const REQUEST_BODY_LIMITS = Object.freeze({
  encoded: 64 * 1_024 * 1_024,
  decoded: 128 * 1_024 * 1_024,
});

export type RequestBodyLimits = Readonly<{ encoded: number; decoded: number }>;

export class RequestBodyTooLargeError extends Error {}
export class RequestBodyIdleTimeoutError extends Error {
  constructor() {
    super('Request body timed out');
    this.name = 'RequestBodyIdleTimeoutError';
  }
}

export type RequestBodyReadOptions = {
  readonly signal?: AbortSignal;
  readonly idleTimeoutMs?: number;
};

export async function withAbortAndIdle<T>(
  task: Promise<T>,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number,
): Promise<T> {
  if (signal?.aborted) throw abortError(signal.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new RequestBodyIdleTimeoutError()), idleTimeoutMs);
      abort = () => reject(abortError(signal?.reason));
      signal?.addEventListener('abort', abort, { once: true });
      void task.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) signal?.removeEventListener('abort', abort);
  }
}

export function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

export class InvalidCompressedRequestBodyError extends Error {}
export class UnsupportedContentEncodingError extends Error {
  constructor(readonly encoding: string) {
    super('Unsupported request Content-Encoding');
  }
}

export async function readJsonRequest(raw: Request, limits: RequestBodyLimits = REQUEST_BODY_LIMITS): Promise<unknown> {
  return JSON.parse(await readRequestText(raw, limits));
}

// Decode a compressed request as a bounded stream. Unencoded bodies stay
// streamed so official-max multipart edits are not buffered. Unknown encodings
// throw UnsupportedContentEncodingError before any parse.
export async function decodedRequestStream(
  raw: Request,
  limits: RequestBodyLimits = REQUEST_BODY_LIMITS,
  options?: RequestBodyReadOptions,
): Promise<ReadableStream<Uint8Array> | null> {
  try {
    const encoding = requestContentEncoding(raw.headers.get('content-encoding'));
    if (encoding === undefined) return raw.body;
    return streamDecodeRequestBody(raw.body, encoding, limits, options);
  } catch (error) {
    await cancelRequestBody(raw, error);
    throw error;
  }
}

// Read and decode a request body to text, honoring content-encoding. Callers
// that must forward the client's exact bytes (e.g. Gemini raw passthrough, which
// rewrites the model in the URL rather than the body) reuse this text verbatim.
export async function readRequestText(raw: Request, limits: RequestBodyLimits = REQUEST_BODY_LIMITS): Promise<string> {
  const branches = [raw];
  try {
    const encoding = requestContentEncoding(raw.headers.get('content-encoding'));
    const branch = raw.clone();
    branches.push(branch);
    const encoded = await readRequestBytes(branch.body, limits.encoded);
    const bytes = encoding === undefined ? encoded : await decodeRequestBytes(encoded, encoding, limits.decoded);
    return new TextDecoder().decode(bytes);
  } catch (error) {
    await Promise.all(branches.map((request) => cancelRequestBody(request, error)));
    throw error;
  }
}

type ContentEncoding = 'br' | 'deflate' | 'gzip' | 'x-gzip' | 'zstd';

function requestContentEncoding(header: string | null): ContentEncoding | undefined {
  const encodings = (header ?? '')
    .split(',')
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding !== '' && encoding !== 'identity');
  const [first] = encodings;
  if (first === undefined) return undefined;
  const encoding = encodings.join(', ');
  if (encodings.length > 1 || !isContentEncoding(first)) {
    console.warn('request.content_encoding.unsupported', { encoding });
    throw new UnsupportedContentEncodingError(encoding);
  }
  return first;
}

function isContentEncoding(value: string): value is ContentEncoding {
  return value === 'br' || value === 'deflate' || value === 'gzip' || value === 'x-gzip' || value === 'zstd';
}

type ContentDecoder = BrotliDecompress | Gunzip | Inflate | InflateRaw | ZstdDecompress;

type DecoderSession = {
  decoder: ContentDecoder;
  error?: unknown;
  pending: Uint8Array[];
  decoded: number;
};

function streamDecodeRequestBody(
  body: ReadableStream<Uint8Array> | null,
  encoding: ContentEncoding,
  limits: RequestBodyLimits,
  options: RequestBodyReadOptions | undefined,
): ReadableStream<Uint8Array> {
  const reader = body?.getReader();
  if (reader === undefined) throw new InvalidCompressedRequestBodyError('Invalid compressed request body');
  const session = bindDecoder(createContentDecoder(encoding, limits.decoded), limits);
  let encoded = 0;
  let sourceDone = false;
  let finished = false;
  let deflateFallbackUsed = false;
  const deflatePrefix: Uint8Array[] = [];

  const awaitDecoder = (task: Promise<void>): Promise<void> =>
    options?.idleTimeoutMs === undefined ? task : withAbortAndIdle(task, options.signal, options.idleTimeoutMs);

  const writeEncoded = async (chunk: Uint8Array): Promise<void> => {
    encoded += chunk.byteLength;
    if (encoded > limits.encoded) throw new RequestBodyTooLargeError('Request body too large');
    if (encoding === 'deflate' && !deflateFallbackUsed) deflatePrefix.push(chunk.slice());
    try {
      await awaitDecoder(writeDecoder(session, chunk));
      if (session.decoded > 0) deflatePrefix.length = 0;
    } catch (error) {
      if (encoding !== 'deflate' || deflateFallbackUsed || session.decoded > 0 || errorCode(error) !== 'Z_DATA_ERROR') {
        throw mapDecodeError(error);
      }
      deflateFallbackUsed = true;
      rebindDecoder(session, createInflateRaw({ maxOutputLength: limits.decoded }), limits);
      for (const part of deflatePrefix) await awaitDecoder(writeDecoder(session, part));
      deflatePrefix.length = 0;
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (session.pending.length === 0 && !finished) {
          if (!sourceDone) {
            const next =
              options?.idleTimeoutMs === undefined
                ? await reader.read()
                : await withAbortAndIdle(reader.read(), options.signal, options.idleTimeoutMs);
            if (next.done) {
              sourceDone = true;
              try {
                await awaitDecoder(endDecoder(session));
              } catch (error) {
                if (
                  encoding === 'deflate' &&
                  !deflateFallbackUsed &&
                  session.decoded === 0 &&
                  errorCode(error) === 'Z_DATA_ERROR'
                ) {
                  deflateFallbackUsed = true;
                  rebindDecoder(session, createInflateRaw({ maxOutputLength: limits.decoded }), limits);
                  for (const part of deflatePrefix) await awaitDecoder(writeDecoder(session, part));
                  await awaitDecoder(endDecoder(session));
                } else {
                  throw mapDecodeError(error);
                }
              }
              finished = true;
              continue;
            }
            await writeEncoded(next.value);
            continue;
          }
          finished = true;
        }
        const next = session.pending.shift();
        if (next !== undefined) {
          controller.enqueue(next);
          return;
        }
        controller.close();
      } catch (error) {
        const mapped = mapDecodeError(error);
        void reader.cancel(mapped).catch(() => undefined);
        session.decoder.destroy();
        controller.error(mapped);
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
      session.decoder.destroy();
    },
  });
}

function createContentDecoder(encoding: ContentEncoding, maxOutputLength: number): ContentDecoder {
  const options = { maxOutputLength };
  switch (encoding) {
    case 'br':
      return createBrotliDecompress(options);
    case 'deflate':
      return createInflate(options);
    case 'gzip':
    case 'x-gzip':
      return createGunzip(options);
    case 'zstd':
      return createZstdDecompress(options);
  }
}

function bindDecoder(decoder: ContentDecoder, limits: RequestBodyLimits): DecoderSession {
  const session: DecoderSession = { decoder, pending: [], decoded: 0 };
  attachDecoderListeners(session, limits);
  return session;
}

function rebindDecoder(session: DecoderSession, decoder: ContentDecoder, limits: RequestBodyLimits): void {
  session.decoder.removeAllListeners();
  session.decoder.destroy();
  session.decoder = decoder;
  session.error = undefined;
  attachDecoderListeners(session, limits);
}

function attachDecoderListeners(session: DecoderSession, limits: RequestBodyLimits): void {
  session.decoder.on('data', (chunk: Buffer) => {
    session.decoded += chunk.byteLength;
    if (session.decoded > limits.decoded) {
      session.error = new RequestBodyTooLargeError('Request body too large');
      session.decoder.destroy();
      return;
    }
    session.pending.push(Uint8Array.from(chunk));
  });
  session.decoder.on('error', (error: Error) => {
    session.error ??= error;
  });
}

function writeDecoder(session: DecoderSession, chunk: Uint8Array): Promise<void> {
  return awaitDecoderCallback(session, (decoder, done) => {
    decoder.write(chunk, done);
  });
}

function endDecoder(session: DecoderSession): Promise<void> {
  return awaitDecoderCallback(session, (decoder, done) => {
    decoder.end(done);
  });
}

function awaitDecoderCallback(
  session: DecoderSession,
  start: (decoder: ContentDecoder, done: (error?: Error | null) => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (session.error !== undefined) {
      reject(session.error);
      return;
    }
    const onError = () => {
      cleanup();
      reject(session.error);
    };
    const cleanup = () => {
      session.decoder.off('error', onError);
    };
    session.decoder.once('error', onError);
    start(session.decoder, (error?: Error | null) => {
      cleanup();
      if (session.error !== undefined) {
        reject(session.error);
        return;
      }
      if (error !== undefined && error !== null) {
        reject(mapDecodeError(error));
        return;
      }
      resolve();
    });
  });
}

function mapDecodeError(error: unknown): unknown {
  if (error instanceof RequestBodyTooLargeError || error instanceof RequestBodyIdleTimeoutError) return error;
  if (errorCode(error) === 'ERR_BUFFER_TOO_LARGE') return new RequestBodyTooLargeError('Request body too large');
  if (isCompressedDataError(error)) return new InvalidCompressedRequestBodyError('Invalid compressed request body');
  return error;
}

async function decodeRequestBytes(
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

function isCompressedDataError(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === 'Z_DATA_ERROR' ||
    code === 'Z_BUF_ERROR' ||
    code?.startsWith('ERR_BROTLI_DECODER_') === true ||
    code?.startsWith('ZSTD_error_') === true
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

async function readRequestBytes(
  body: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
  options?: RequestBodyReadOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next =
        options?.idleTimeoutMs === undefined
          ? await reader.read()
          : await withAbortAndIdle(reader.read(), options.signal, options.idleTimeoutMs);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        const error = new RequestBodyTooLargeError('Request body too large');
        void reader.cancel(error).catch(() => undefined);
        throw error;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function cancelRequestBody(request: Request, reason: unknown): Promise<void> {
  try {
    await request.body?.cancel(reason);
  } catch {}
}

export async function rewriteJsonRequestModel(raw: Request, modelId: string): Promise<Request> {
  const body = jsonObjectSchema.parse(await readJsonRequest(raw));
  const headers = new Headers(raw.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Request(raw, {
    method: raw.method,
    body: JSON.stringify({ ...body, model: modelId }),
    headers,
  });
}
