import { z } from "zod";

const jsonObjectSchema = z.object({}).catchall(z.unknown());

export class RequestBodyTooLargeError extends Error {}

export async function readJsonRequest(raw: Request, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
  const reader = raw.clone().body?.getReader();
  if (reader === undefined) return JSON.parse("");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request body too large");
        throw new RequestBodyTooLargeError("Request body too large");
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
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function rewriteJsonRequestModel(raw: Request, modelId: string): Promise<Request> {
  const body = jsonObjectSchema.parse(await readJsonRequest(raw));
  const headers = new Headers(raw.headers);
  headers.delete("content-length");
  return new Request(raw, {
    body: JSON.stringify({ ...body, model: modelId }),
    headers,
  });
}
