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

const MAX_HEADER_VALUE_CHARACTERS = 512;
const REDACTED = "[REDACTED]";
const retainedHeaders = new Set(["host", "content-type", "content-length", "accept", "accept-encoding", "user-agent"]);

export async function snapshotRequest(request: Request): Promise<HttpRequestSnapshot> {
  try {
    const snapshot: HttpRequestSnapshot = {
      method: safeMethod(request),
      url: safeUrl(request),
      headers: safeHeaders(request.headers),
    };
    if (request.body === null) return snapshot;
    const metadataOnly = requestBodyMetadataOnly(request.headers);
    return { ...snapshot, body: metadataOnly ?? (await snapshotRequestBody(request.body, request.headers)) };
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
    return { ...snapshot, body: await snapshotResponseBody(response.body, response.headers) };
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

import { requestBodyMetadataOnly, snapshotRequestBody, snapshotResponseBody } from "./snapshot-body";
