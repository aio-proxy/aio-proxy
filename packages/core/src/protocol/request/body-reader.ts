import { RequestBodyTooLargeError } from './errors';
import { withAbortAndIdle } from './idle';
import type { RequestBodyLimits } from './limits';

export type RequestBodyReadOptions = {
  readonly signal?: AbortSignal;
  readonly idleTimeoutMs?: number;
};

export async function readRequestBytes(
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

export async function cancelRequestBody(request: Request, reason: unknown): Promise<void> {
  try {
    await request.body?.cancel(reason);
  } catch {}
}

export function boundedRequestStream(
  body: ReadableStream<Uint8Array> | null,
  limits: RequestBodyLimits,
  options?: RequestBodyReadOptions,
): ReadableStream<Uint8Array> | null {
  if (body === null) return null;
  const reader = body.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next =
          options?.idleTimeoutMs === undefined
            ? await reader.read()
            : await withAbortAndIdle(reader.read(), options.signal, options.idleTimeoutMs);
        if (next.done) {
          reader.releaseLock();
          controller.close();
          return;
        }
        total += next.value.byteLength;
        if (total > limits.encoded || total > limits.decoded) {
          throw new RequestBodyTooLargeError('Request body too large');
        }
        controller.enqueue(next.value);
      } catch (error) {
        void reader.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
