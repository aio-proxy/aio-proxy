import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createInflateRaw,
  createZstdDecompress,
  type BrotliDecompress,
  type Gunzip,
  type Inflate,
  type InflateRaw,
  type ZstdDecompress,
} from 'node:zlib';

import type { RequestBodyReadOptions } from './body-reader';
import type { ContentEncoding } from './content-encoding';
import { errorCode, InvalidCompressedRequestBodyError, mapDecodeError, RequestBodyTooLargeError } from './errors';
import { withAbortAndIdle } from './idle';
import type { RequestBodyLimits } from './limits';

type ContentDecoder = BrotliDecompress | Gunzip | Inflate | InflateRaw | ZstdDecompress;

const PENDING_HIGH_WATER = 64 * 1024;
const PENDING_LOW_WATER = 16 * 1024;

type DecoderSession = {
  decoder: ContentDecoder;
  error?: unknown;
  pending: Uint8Array[];
  pendingBytes: number;
  decoded: number;
  paused: boolean;
  notify?: () => void;
};

export function streamDecodeRequestBody(
  body: ReadableStream<Uint8Array> | null,
  encoding: ContentEncoding,
  limits: RequestBodyLimits,
  options: RequestBodyReadOptions | undefined,
): ReadableStream<Uint8Array> {
  const reader = body?.getReader();
  if (reader === undefined) throw new InvalidCompressedRequestBodyError('Invalid compressed request body');
  const session = bindDecoder(createContentDecoder(encoding, limits.decoded), limits);
  let encoded = 0;
  let finished = false;
  let pumping: Promise<void> | undefined;
  let pumpError: unknown;
  let deflateFallbackUsed = false;
  const deflatePrefix: Uint8Array[] = [];

  const awaitDecoder = (task: Promise<void>): Promise<void> =>
    options?.idleTimeoutMs === undefined ? task : withAbortAndIdle(task, options.signal, options.idleTimeoutMs);

  const writeEncoded = async (chunk: Uint8Array): Promise<void> => {
    encoded += chunk.byteLength;
    if (encoded > limits.encoded)
      throw new RequestBodyTooLargeError('Request body too large', {
        stage: 'encoded',
        limitBytes: limits.encoded,
        measurement: 'observed_lower_bound',
        bytes: encoded,
      });
    if (encoding === 'deflate' && !deflateFallbackUsed) deflatePrefix.push(chunk.slice());
    try {
      await awaitDecoder(writeDecoder(session, chunk));
      if (session.decoded > 0) deflatePrefix.length = 0;
    } catch (error) {
      if (encoding !== 'deflate' || deflateFallbackUsed || session.decoded > 0 || errorCode(error) !== 'Z_DATA_ERROR') {
        throw mapDecodeError(error, limits.decoded);
      }
      deflateFallbackUsed = true;
      rebindDecoder(session, createInflateRaw({ maxOutputLength: limits.decoded }), limits);
      for (const part of deflatePrefix) await awaitDecoder(writeDecoder(session, part));
      deflatePrefix.length = 0;
    }
  };

  const pump = async (): Promise<void> => {
    try {
      for (;;) {
        const next =
          options?.idleTimeoutMs === undefined
            ? await reader.read()
            : await withAbortAndIdle(reader.read(), options.signal, options.idleTimeoutMs);
        if (next.done) {
          try {
            await awaitDecoder(endDecoder(session));
          } catch (error) {
            if (
              encoding !== 'deflate' ||
              deflateFallbackUsed ||
              session.decoded > 0 ||
              errorCode(error) !== 'Z_DATA_ERROR'
            ) {
              throw mapDecodeError(error, limits.decoded);
            }
            deflateFallbackUsed = true;
            rebindDecoder(session, createInflateRaw({ maxOutputLength: limits.decoded }), limits);
            for (const part of deflatePrefix) await awaitDecoder(writeDecoder(session, part));
            await awaitDecoder(endDecoder(session));
          }
          finished = true;
          wakeDecoder(session);
          return;
        }
        await writeEncoded(next.value);
      }
    } catch (error) {
      pumpError = mapDecodeError(error, limits.decoded);
      session.decoder.destroy();
      wakeDecoder(session);
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      pumping ??= pump();
      try {
        while (session.pending.length === 0 && pumpError === undefined && !finished) {
          await waitForPending(session, () => finished || pumpError !== undefined);
        }
        if (pumpError !== undefined) throw pumpError;
        const next = dequeuePending(session);
        if (next !== undefined) {
          controller.enqueue(next);
          return;
        }
        controller.close();
      } catch (error) {
        const mapped = mapDecodeError(error, limits.decoded);
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
  const session: DecoderSession = { decoder, pending: [], pendingBytes: 0, decoded: 0, paused: false };
  attachDecoderListeners(session, limits);
  return session;
}

function rebindDecoder(session: DecoderSession, decoder: ContentDecoder, limits: RequestBodyLimits): void {
  session.decoder.removeAllListeners();
  session.decoder.destroy();
  session.decoder = decoder;
  session.error = undefined;
  session.paused = false;
  attachDecoderListeners(session, limits);
}

function attachDecoderListeners(session: DecoderSession, limits: RequestBodyLimits): void {
  session.decoder.on('data', (chunk: Buffer) => {
    session.decoded += chunk.byteLength;
    if (session.decoded > limits.decoded) {
      session.error = new RequestBodyTooLargeError('Request body too large', {
        stage: 'decoded',
        limitBytes: limits.decoded,
        measurement: 'observed_lower_bound',
        bytes: session.decoded,
      });
      session.decoder.destroy();
      wakeDecoder(session);
      return;
    }
    session.pending.push(Uint8Array.from(chunk));
    session.pendingBytes += chunk.byteLength;
    if (session.pendingBytes >= PENDING_HIGH_WATER) {
      session.paused = true;
      session.decoder.pause();
    }
    wakeDecoder(session);
  });
  session.decoder.on('error', (error: Error) => {
    session.error ??= error;
    wakeDecoder(session);
  });
}

function dequeuePending(session: DecoderSession): Uint8Array | undefined {
  const next = session.pending.shift();
  if (next === undefined) return undefined;
  session.pendingBytes -= next.byteLength;
  if (session.paused && session.pendingBytes <= PENDING_LOW_WATER) {
    session.paused = false;
    session.decoder.resume();
  }
  return next;
}

function waitForPending(session: DecoderSession, isIdle: () => boolean): Promise<void> {
  if (session.pending.length > 0 || session.error !== undefined || isIdle()) return Promise.resolve();
  return new Promise((resolve) => {
    session.notify = resolve;
    if (session.pending.length > 0 || session.error !== undefined || isIdle()) {
      session.notify = undefined;
      resolve();
    }
  });
}

function wakeDecoder(session: DecoderSession): void {
  const notify = session.notify;
  session.notify = undefined;
  notify?.();
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
        reject(error);
        return;
      }
      resolve();
    });
  });
}
