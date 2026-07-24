import { REQUEST_BODY_LIMITS } from "@aio-proxy/core";

import type { SafeBodySnapshot, SafeJsonValue, SafeValueDescriptor } from "./snapshot";

const MAX_JSON_BYTES = 1024 * 1024;
// Diagnostic clones must release stream resources promptly even when an endpoint never finishes a body.
const BODY_DEADLINE_MS = 1_000;
const MAX_HEADER_VALUE_CHARACTERS = 512;
const DEADLINE = Symbol("deadline");
const credentialKey = /(?:api.?key|auth(?:orization)?|token|secret|credential|password|cookie)/iu;
const payloadKeys = new Set([
  "prompt",
  "instructions",
  "input",
  "input_text",
  "output",
  "output_text",
  "text",
  "content",
  "arguments",
  "args",
  "response",
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
const retainedControlPaths = new Set([
  "model",
  "stream",
  "type",
  "reasoning.effort",
  "output_config.effort",
  "thinking.type",
  "messages.#.role",
  "messages.#.content.#.type",
  "messages.#.tool_calls.#.type",
  "input.#.role",
  "input.#.type",
  "input.#.content.#.type",
  "contents.#.role",
  "tools.#.type",
]);

export function requestBodyMetadataOnly(headers: Headers): SafeBodySnapshot | undefined {
  const contentLength = headers.get("content-length");
  if (contentLength === null) return undefined;
  const type = mediaType(headers);
  if (!/^\d+$/u.test(contentLength)) return metadata(type, { omitted: "unreadable" });
  if (Number(contentLength) <= REQUEST_BODY_LIMITS.encoded) return undefined;
  return metadata(type, {
    atLeastByteLength: REQUEST_BODY_LIMITS.encoded + 1,
    omitted: "oversized",
  });
}

export async function snapshotRequestBody(
  body: ReadableStream<Uint8Array>,
  headers: Headers,
): Promise<SafeBodySnapshot> {
  return await snapshotBoundedBody(body, headers, REQUEST_BODY_LIMITS.encoded);
}

export async function snapshotResponseBody(
  body: ReadableStream<Uint8Array>,
  headers: Headers,
): Promise<SafeBodySnapshot> {
  return await snapshotBoundedBody(body, headers, MAX_JSON_BYTES);
}

function mediaType(headers: Headers): string | undefined {
  try {
    const value = headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase()
      .slice(0, MAX_HEADER_VALUE_CHARACTERS);
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

async function snapshotBoundedBody(
  body: ReadableStream<Uint8Array>,
  headers: Headers,
  maxBytes: number,
): Promise<SafeBodySnapshot> {
  const type = mediaType(headers);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), BODY_DEADLINE_MS);
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === DEADLINE) {
        cancelReader(reader, "request snapshot deadline exceeded");
        return metadata(type, { omitted: "unreadable" });
      }
      if (next.done) return await snapshotBytes(joinBytes(chunks, byteLength), type);
      if (byteLength + next.value.byteLength > maxBytes) {
        cancelReader(reader, "request snapshot body too large");
        return metadata(type, { atLeastByteLength: maxBytes + 1, omitted: "oversized" });
      }
      chunks.push(next.value);
      byteLength += next.value.byteLength;
    }
  } catch {
    cancelReader(reader, "request snapshot body unreadable");
    return metadata(type, { omitted: "unreadable" });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {}
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: string): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {}
}

async function snapshotBytes(bytes: Uint8Array<ArrayBuffer>, type: string | undefined): Promise<SafeBodySnapshot> {
  const details = {
    ...(type === undefined ? {} : { mediaType: type }),
    byteLength: bytes.byteLength,
    sha256: await sha256(bytes),
  };
  if (!isJson(type)) return { ...details, omitted: "non-json" };
  if (bytes.byteLength > MAX_JSON_BYTES) return { ...details, omitted: "oversized" };
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return { ...details, json: await sanitizeJson(value) };
  } catch {
    return { ...details, omitted: "unreadable" };
  }
}

function isJson(type: string | undefined): boolean {
  return type === "application/json" || type?.endsWith("+json") === true;
}

async function sanitizeJson(
  value: unknown,
  path: readonly (string | number)[] = [],
  insidePayload = false,
): Promise<SafeJsonValue> {
  const key = typeof path.at(-1) === "string" ? (path.at(-1) as string) : undefined;
  if (key !== undefined && credentialKey.test(key)) return descriptor("redacted", value, false);
  const payload = insidePayload || (key !== undefined && payloadKeys.has(key.toLowerCase()));
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (retainedControlPaths.has(path.map((part) => (typeof part === "number" ? "#" : part)).join("."))) return value;
    return await descriptor(payload ? "payload" : "string", value, true);
  }
  if (Array.isArray(value)) {
    return await Promise.all(value.map((item, index) => sanitizeJson(item, [...path, index], payload)));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([name, item]) => [name, await sanitizeJson(item, [...path, name], payload)]),
      ),
    );
  }
  return await descriptor(payload ? "payload" : "string", String(value), true);
}

async function descriptor(
  kind: SafeValueDescriptor["kind"],
  value: unknown,
  includeDigest: boolean,
): Promise<SafeValueDescriptor> {
  const serialized = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  const bytes = new TextEncoder().encode(serialized);
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

function metadata(type: string | undefined, body: Omit<SafeBodySnapshot, "mediaType">): SafeBodySnapshot {
  return { ...(type === undefined ? {} : { mediaType: type }), ...body };
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
