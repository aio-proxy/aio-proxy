import { promisify } from "node:util";
import { brotliDecompress, gunzip, inflate, inflateRaw, zstdDecompress } from "node:zlib";
import { z } from "zod";

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
export class InvalidCompressedRequestBodyError extends Error {}
export class UnsupportedContentEncodingError extends Error {
  constructor(readonly encoding: string) {
    super("Unsupported request Content-Encoding");
  }
}

export async function readJsonRequest(raw: Request, limits: RequestBodyLimits = REQUEST_BODY_LIMITS): Promise<unknown> {
  const branch = raw.clone();
  try {
    const encoded = await readRequestBytes(branch.body, limits.encoded);
    const encoding = requestContentEncoding(branch.headers.get("content-encoding"));
    const bytes = encoding === undefined ? encoded : await decodeRequestBytes(encoded, encoding, limits.decoded);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    await Promise.all([cancelRequestBody(branch, error), cancelRequestBody(raw, error)]);
    throw error;
  }
}

type ContentEncoding = "br" | "deflate" | "gzip" | "x-gzip" | "zstd";

function requestContentEncoding(header: string | null): ContentEncoding | undefined {
  const encodings = (header ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding !== "" && encoding !== "identity");
  if (encodings.length === 0) return undefined;
  const encoding = encodings.join(", ");
  if (encodings.length > 1 || !isContentEncoding(encodings[0])) {
    console.warn("request.content_encoding.unsupported", { encoding });
    throw new UnsupportedContentEncodingError(encoding);
  }
  return encodings[0];
}

function isContentEncoding(value: string): value is ContentEncoding {
  return value === "br" || value === "deflate" || value === "gzip" || value === "x-gzip" || value === "zstd";
}

async function decodeRequestBytes(
  encoded: Uint8Array,
  encoding: ContentEncoding,
  maxOutputLength: number,
): Promise<Uint8Array> {
  try {
    switch (encoding) {
      case "br":
        return await brotliDecompressAsync(encoded, { maxOutputLength });
      case "deflate":
        return await inflateDeflate(encoded, maxOutputLength);
      case "gzip":
      case "x-gzip":
        return await gunzipAsync(encoded, { maxOutputLength });
      case "zstd":
        return await zstdDecompressAsync(encoded, { maxOutputLength });
    }
  } catch (error) {
    if (errorCode(error) === "ERR_BUFFER_TOO_LARGE") {
      throw new RequestBodyTooLargeError("Request body too large");
    }
    if (isCompressedDataError(error)) {
      throw new InvalidCompressedRequestBodyError("Invalid compressed request body");
    }
    throw error;
  }
}

async function inflateDeflate(encoded: Uint8Array, maxOutputLength: number): Promise<Uint8Array> {
  try {
    return await inflateAsync(encoded, { maxOutputLength });
  } catch (error) {
    if (errorCode(error) !== "Z_DATA_ERROR") throw error;
    return inflateRawAsync(encoded, { maxOutputLength });
  }
}

function isCompressedDataError(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "Z_DATA_ERROR" ||
    code === "Z_BUF_ERROR" ||
    code?.startsWith("ERR_BROTLI_DECODER_") === true ||
    code?.startsWith("ZSTD_error_") === true
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function readRequestBytes(
  body: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
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
