import { once } from 'node:events';
import { closeSync, createWriteStream, fchmodSync, openSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';

import { abortError, RequestBodyTooLargeError, withAbortAndIdle } from '../../protocol/request';

// Process-wide ceiling on a spooled multipart envelope, mirroring the server's
// max request body size. It bounds disk use before any protocol-specific limit
// applies, so it is not a per-protocol compatibility knob.
export const MULTIPART_ENCODED_LIMIT = 851_048_559;

export type MultipartSpool = {
  readonly path: string;
  unlink(): Promise<void>;
};

const spools = new WeakMap<Request, MultipartSpool>();
const spoolFinalizers = new FinalizationRegistry((path: string) => {
  void unlink(path).catch(() => undefined);
});

export async function spoolMultipartBody(
  raw: Request,
  idleTimeoutMs: number,
  filePrefix = 'aio-proxy-multipart',
): Promise<MultipartSpool> {
  const reader = raw.body?.getReader();
  if (reader === undefined) throw syntax();
  const path = join(tmpdir(), `${filePrefix}-${crypto.randomUUID()}`);
  let writer: ReturnType<typeof createWriteStream> | undefined;
  let total = 0;
  try {
    for (;;) {
      const next = await withAbortAndIdle(reader.read(), raw.signal, idleTimeoutMs);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MULTIPART_ENCODED_LIMIT) throw new RequestBodyTooLargeError('Request body too large');
      if (writer === undefined) {
        const fd = openSync(path, 'wx', 0o600);
        try {
          fchmodSync(fd, 0o600);
          writer = createWriteStream(path, { fd, autoClose: true });
        } catch (error) {
          closeSync(fd);
          throw error;
        }
      }
      if (!writer.write(next.value)) await once(writer, 'drain');
    }
    if (writer === undefined) throw syntax();
    writer.end();
    await finished(writer);
    return createSpool(path);
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    writer?.destroy();
    void unlink(path).catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released after cancel.
    }
  }
}

export function retainMultipartSpool(raw: Request, spool: MultipartSpool): void {
  spools.set(raw, spool);
  spoolFinalizers.register(raw, spool.path);
  raw.signal.addEventListener('abort', () => void spool.unlink(), { once: true });
}

export async function releaseMultipartSpool(raw: Request): Promise<void> {
  const spool = spools.get(raw);
  if (spool === undefined) return;
  spools.delete(raw);
  await spool.unlink();
}

export function multipartSpoolPath(raw: Request): string | undefined {
  return spools.get(raw)?.path;
}

export function replaySpooledMultipartRaw(raw: Request): Request {
  const spool = spools.get(raw);
  if (spool === undefined) throw syntax();
  const file = Bun.file(spool.path);
  const headers = new Headers(raw.headers);
  headers.delete('transfer-encoding');
  headers.set('content-length', String(file.size));
  return new Request(raw.url, {
    method: raw.method,
    headers,
    body: file,
    signal: raw.signal,
  });
}

// Process-protection cap on concurrent official-max multipart parses. This is not
// a compatibility ceiling and does not shrink the per-request encoded limit.
const MAX_IN_FLIGHT_MULTIPART_PARSES = 2;
let inFlightMultipartParses = 0;
const multipartWaiters: Array<() => void> = [];

export async function acquireMultipartSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal.reason);
  if (inFlightMultipartParses < MAX_IN_FLIGHT_MULTIPART_PARSES) {
    inFlightMultipartParses += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const waiter = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      inFlightMultipartParses += 1;
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      const index = multipartWaiters.indexOf(waiter);
      if (index !== -1) multipartWaiters.splice(index, 1);
      reject(abortError(signal?.reason));
    };
    multipartWaiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function releaseMultipartSlot(): void {
  inFlightMultipartParses -= 1;
  multipartWaiters.shift()?.();
}

function createSpool(path: string): MultipartSpool {
  let removed = false;
  return {
    path,
    async unlink() {
      if (removed) return;
      removed = true;
      await unlink(path).catch(() => undefined);
    },
  };
}

// The spool runs before any protocol adapter is chosen, so it cannot name one.
// Every protocol error mapper turns SyntaxError into its own 400 shape.
function syntax(): SyntaxError {
  return new SyntaxError('Invalid multipart request');
}
