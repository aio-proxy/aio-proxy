import { z } from "zod";

const jsonObjectSchema = z.object({}).catchall(z.unknown());

export class RequestBodyTooLargeError extends Error {}

export async function readJsonRequest(raw: Request, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
  const branch = raw.clone();
  try {
    const body =
      branch.headers.get("content-encoding")?.toLowerCase() === "gzip"
        ? branch.body?.pipeThrough(new DecompressionStream("gzip"))
        : branch.body;
    return JSON.parse(new TextDecoder().decode(await readRequestBytes(body, maxBytes)));
  } catch (error) {
    await Promise.all([cancelRequestBody(branch, error), cancelRequestBody(raw, error)]);
    throw error;
  }
}

async function readRequestBytes(
  body: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        const error = new RequestBodyTooLargeError("Request body too large");
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
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Request(raw, {
    body: JSON.stringify({ ...body, model: modelId }),
    headers,
  });
}
