export type SafeValueDescriptor = {
  readonly kind: "payload" | "redacted" | "string";
  readonly byteLength: number;
  readonly sha256?: string;
};

export type SafeJsonValue =
  | null
  | boolean
  | number
  | string
  | SafeValueDescriptor
  | readonly SafeJsonValue[]
  | { readonly [key: string]: SafeJsonValue };

export type SafeBodySnapshot = {
  readonly mediaType?: string;
  readonly byteLength?: number;
  readonly atLeastByteLength?: number;
  readonly sha256?: string;
  readonly json?: SafeJsonValue;
  readonly omitted?: "non-json" | "oversized" | "unreadable";
};

export type HttpRequestSnapshot = {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: SafeBodySnapshot;
};

export type HttpResponseSnapshot = {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: SafeBodySnapshot;
};

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_HEADER_VALUE_CHARACTERS = 512;
const REDACTED = "[REDACTED]";
const retainedHeaders = new Set(["host", "content-type", "content-length", "accept", "accept-encoding", "user-agent"]);
const retainedStringKeys = new Set(["model", "stream", "role", "type", "effort"]);
const credentialKey = /(?:api.?key|auth(?:orization)?|token|secret|credential|password|cookie)/iu;
const payloadKeys = new Set([
  "prompt",
  "instructions",
  "input_text",
  "output_text",
  "text",
  "content",
  "arguments",
  "result",
  "tool_result",
  "image",
  "image_data",
  "image_url",
  "file",
  "file_data",
  "audio",
  "data",
  "encrypted_content",
]);

export async function snapshotRequest(request: Request): Promise<HttpRequestSnapshot> {
  try {
    const snapshot: HttpRequestSnapshot = {
      method: safeMethod(request),
      url: safeUrl(request),
      headers: safeHeaders(request.headers),
    };
    if (request.body === null) return snapshot;
    return { ...snapshot, body: await snapshotCompleteBody(request, request.headers) };
  } catch {
    return { method: "[UNREADABLE]", url: "[UNREADABLE]", headers: {}, body: { omitted: "unreadable" } };
  }
}

export async function snapshotResponse(response: Response): Promise<HttpResponseSnapshot> {
  try {
    const snapshot: HttpResponseSnapshot = {
      statusCode: response.status,
      headers: safeHeaders(response.headers),
    };
    if (response.status >= 200 && response.status < 300) return snapshot;
    if (response.body === null) return snapshot;
    return { ...snapshot, body: await snapshotBoundedBody(response.body, response.headers) };
  } catch {
    return { statusCode: 0, headers: {}, body: { omitted: "unreadable" } };
  }
}

function safeMethod(request: Request): string {
  try {
    return request.method.slice(0, 32);
  } catch {
    return "[UNREADABLE]";
  }
}

function safeUrl(request: Request): string {
  try {
    const url = new URL(request.url);
    url.username = "";
    url.password = "";
    const redacted = new URLSearchParams();
    for (const [name] of url.searchParams) redacted.append(name, REDACTED);
    url.search = redacted.toString();
    return url.toString();
  } catch {
    return "[UNREADABLE]";
  }
}

function safeHeaders(headers: Headers): Readonly<Record<string, string>> {
  try {
    return Object.fromEntries(
      [...headers].map(([name, value]) => [
        name,
        retainedHeaders.has(name.toLowerCase()) ? value.slice(0, MAX_HEADER_VALUE_CHARACTERS) : REDACTED,
      ]),
    );
  } catch {
    return {};
  }
}

function mediaType(headers: Headers): string | undefined {
  try {
    const value = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

async function snapshotCompleteBody(body: Body, headers: Headers): Promise<SafeBodySnapshot> {
  const type = mediaType(headers);
  try {
    const bytes = new Uint8Array(await body.arrayBuffer());
    return await snapshotBytes(bytes, type);
  } catch {
    return { ...(type === undefined ? {} : { mediaType: type }), omitted: "unreadable" };
  }
}

async function snapshotBoundedBody(body: ReadableStream<Uint8Array>, headers: Headers): Promise<SafeBodySnapshot> {
  const type = mediaType(headers);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return await snapshotBytes(joinBytes(chunks, byteLength), type);
      if (byteLength + next.value.byteLength > MAX_JSON_BYTES) {
        void reader.cancel().catch(() => {});
        return {
          ...(type === undefined ? {} : { mediaType: type }),
          atLeastByteLength: MAX_JSON_BYTES + 1,
          omitted: "oversized",
        };
      }
      chunks.push(next.value);
      byteLength += next.value.byteLength;
    }
  } catch {
    void reader.cancel().catch(() => {});
    return { ...(type === undefined ? {} : { mediaType: type }), omitted: "unreadable" };
  } finally {
    reader.releaseLock();
  }
}

async function snapshotBytes(bytes: Uint8Array<ArrayBuffer>, type: string | undefined): Promise<SafeBodySnapshot> {
  const metadata = {
    ...(type === undefined ? {} : { mediaType: type }),
    byteLength: bytes.byteLength,
    sha256: await sha256(bytes),
  };
  if (!isJson(type)) return { ...metadata, omitted: "non-json" };
  if (bytes.byteLength > MAX_JSON_BYTES) return { ...metadata, omitted: "oversized" };
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return { ...metadata, json: await sanitizeJson(value) };
  } catch {
    return { ...metadata, omitted: "unreadable" };
  }
}

function isJson(type: string | undefined): boolean {
  return type === "application/json" || type?.endsWith("+json") === true;
}

async function sanitizeJson(value: unknown, key?: string): Promise<SafeJsonValue> {
  if (key !== undefined && credentialKey.test(key)) return descriptor("redacted", value, false);
  if (key !== undefined && payloadKeys.has(key.toLowerCase())) return await descriptor("payload", value, true);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (key !== undefined && retainedStringKeys.has(key)) return value;
    return await descriptor("string", value, true);
  }
  if (Array.isArray(value)) return await Promise.all(value.map((item) => sanitizeJson(item)));
  if (typeof value === "object") {
    return Object.fromEntries(
      await Promise.all(Object.entries(value).map(async ([name, item]) => [name, await sanitizeJson(item, name)])),
    );
  }
  return await descriptor("string", String(value), true);
}

async function descriptor(
  kind: SafeValueDescriptor["kind"],
  value: unknown,
  includeDigest: boolean,
): Promise<SafeValueDescriptor> {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
  return {
    kind,
    byteLength: bytes.byteLength,
    ...(includeDigest ? { sha256: await sha256(bytes) } : {}),
  };
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function joinBytes(chunks: readonly Uint8Array[], byteLength: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
