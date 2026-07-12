import { z } from "zod";

const jsonObjectSchema = z.object({}).catchall(z.unknown());

export function readJsonRequest(raw: Request): Promise<unknown> {
  return raw.clone().json();
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
