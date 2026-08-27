import { once } from 'node:events';
import { closeSync, createWriteStream, fchmodSync, openSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';

import { withAbortAndIdle } from '../../protocol/request';
import { EDITS_MULTIPART_ENCODED_LIMIT, tooLarge } from './multipart-counters';

export type MultipartSpool = {
  readonly path: string;
  unlink(): Promise<void>;
};

const spools = new WeakMap<Request, MultipartSpool>();
const spoolFinalizers = new FinalizationRegistry((path: string) => {
  void unlink(path).catch(() => undefined);
});

export async function spoolMultipartBody(raw: Request, idleTimeoutMs: number): Promise<MultipartSpool> {
  const reader = raw.body?.getReader();
  if (reader === undefined) throw new SyntaxError('Invalid OpenAI Images multipart request');
  const path = join(tmpdir(), `aio-proxy-images-${crypto.randomUUID()}`);
  let writer: ReturnType<typeof createWriteStream> | undefined;
  let total = 0;
  try {
    for (;;) {
      const next = await withAbortAndIdle(reader.read(), raw.signal, idleTimeoutMs);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > EDITS_MULTIPART_ENCODED_LIMIT) throw tooLarge();
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
    if (writer === undefined) throw new SyntaxError('Invalid OpenAI Images multipart request');
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
  if (spool === undefined) throw new SyntaxError('Invalid OpenAI Images multipart request');
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
