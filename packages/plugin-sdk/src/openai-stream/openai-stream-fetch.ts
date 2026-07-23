import { createContentDecodedReader, type ContentDecodedReader } from "./content-decoding";
import { createOpenAISseBody, type OpenAIStreamProtocol } from "./sse-terminal";

export type { OpenAIStreamProtocol } from "./sse-terminal";

const OPENAI_ACCEPT_ENCODING = "gzip, deflate, br, zstd" as const;

type BunFetchInit = RequestInit & { decompress?: boolean };

export type OpenAIStreamFetchOptions = {
  readonly rewriteToolImages?: boolean;
};

export function createOpenAIStreamFetch(
  protocol: OpenAIStreamProtocol,
  fetcher?: typeof globalThis.fetch,
  options?: OpenAIStreamFetchOptions,
): typeof globalThis.fetch;
export function createOpenAIStreamFetch(
  protocol: OpenAIStreamProtocol,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  options?: OpenAIStreamFetchOptions,
): typeof globalThis.fetch {
  const resolvedOptions = options ?? {};
  const streamFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const initialRequest = new Request(input, init);
    const request =
      protocol === "openai-compatible" && resolvedOptions.rewriteToolImages === true
        ? await rewriteCompatibleToolImages(initialRequest)
        : initialRequest;
    const headers = new Headers(request.headers);
    headers.set("accept-encoding", OPENAI_ACCEPT_ENCODING);

    const response = await (fetcher as (input: RequestInfo | URL, init?: BunFetchInit) => Promise<Response>)(request, {
      headers,
      decompress: false,
    });
    return normalizeOpenAIStreamResponse(response, protocol);
  };

  // Bun's fetch exposes `preconnect`; DOM lib typings used for DTS may not.
  const platformFetch = globalThis.fetch as typeof globalThis.fetch & {
    preconnect?: (url: string, options?: object) => void;
  };
  return Object.assign(streamFetch, {
    preconnect: platformFetch.preconnect?.bind(platformFetch),
  }) as typeof globalThis.fetch;
}

async function rewriteCompatibleToolImages(request: Request): Promise<Request> {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    !url.pathname.endsWith("/chat/completions") ||
    !request.headers.get("content-type")?.toLowerCase().includes("application/json")
  ) {
    return request;
  }
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return request;
  }
  if (!isRecord(body) || !Array.isArray(body["messages"])) return request;
  let changed = false;
  const messages = body["messages"].map((message: unknown) => {
    if (!isRecord(message) || message["role"] !== "tool" || typeof message["content"] !== "string") return message;
    const content = compatibleToolContent(message["content"]);
    if (content === undefined) return message;
    changed = true;
    return { ...message, content };
  });
  if (!changed) return request;
  const headers = new Headers(request.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Request(request, { method: "POST", headers, body: JSON.stringify({ ...body, messages }) });
}

function compatibleToolContent(content: string): readonly unknown[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || !value.some(isMarkedToolImage)) return undefined;
  return value.map((part) => {
    if (isRecord(part) && part["type"] === "text" && typeof part["text"] === "string") {
      return { type: "text", text: part["text"] };
    }
    if (isMarkedToolImage(part)) return compatibleImagePart(part);
    throw new TypeError("Marked tool image content contains an unsupported part");
  });
}

function isMarkedToolImage(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value) || value["type"] !== "file" || !isRecord(value["providerOptions"])) return false;
  const aioProxy = value["providerOptions"]["aioProxy"];
  return isRecord(aioProxy) && aioProxy["toolImage"] === true;
}

function compatibleImagePart(part: Readonly<Record<string, unknown>>) {
  const mediaType = part["mediaType"];
  const data = part["data"];
  if (typeof mediaType !== "string" || (mediaType !== "image" && !mediaType.startsWith("image/")) || !isRecord(data)) {
    throw new TypeError("Marked tool image is invalid");
  }
  const url =
    data["type"] === "data" && typeof data["data"] === "string"
      ? `data:${mediaType};base64,${data["data"]}`
      : data["type"] === "url" && typeof data["url"] === "string"
        ? data["url"]
        : undefined;
  if (url === undefined) throw new TypeError("Marked tool image source is unsupported");
  const providerOptions = part["providerOptions"];
  const openAI = isRecord(providerOptions) ? providerOptions["openai"] : undefined;
  const detail = isRecord(openAI) ? openAI["imageDetail"] : undefined;
  if (detail !== undefined && detail !== "auto" && detail !== "low" && detail !== "high") {
    throw new TypeError("Marked tool image detail is invalid");
  }
  return {
    type: "image_url" as const,
    image_url: { url, ...(detail === undefined ? {} : { detail }) },
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEventStream(contentType: string | null): boolean {
  return (contentType ?? "").toLowerCase().includes("text/event-stream");
}

function createPlainDecodedBody(decoded: ContentDecodedReader): ReadableStream<Uint8Array> {
  let finished = false;
  let pendingError: unknown;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      if (pendingError !== undefined) {
        const error = pendingError;
        pendingError = undefined;
        finished = true;
        void decoded.cancel(error).catch(() => undefined);
        controller.error(error);
        return;
      }
      const read = await decoded.read();
      for (const chunk of read.chunks) controller.enqueue(chunk);
      if (read.error !== undefined) {
        if (read.chunks.length > 0) {
          pendingError = read.error;
          return;
        }
        finished = true;
        void decoded.cancel(read.error).catch(() => undefined);
        controller.error(read.error);
      } else if (read.done) {
        finished = true;
        controller.close();
      }
    },
    async cancel(reason) {
      finished = true;
      await decoded.cancel(reason);
    },
  });
}

function rebuildResponse(response: Response, body: ReadableStream<Uint8Array> | null): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function normalizeOpenAIStreamResponse(response: Response, protocol: OpenAIStreamProtocol): Response {
  const eventStream = isEventStream(response.headers.get("content-type"));
  if (response.body === null && !eventStream) return response;

  const encoding = response.headers.get("content-encoding");
  const needsDecoding = (encoding ?? "").split(",").some((value) => {
    const token = value.trim().toLowerCase();
    return token !== "" && token !== "identity";
  });
  if (!needsDecoding && !eventStream) return response;

  // Throws before a Response is returned when Content-Encoding is unsupported.
  const source = response.body ?? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  const decoded = createContentDecodedReader(source, encoding);
  const body = eventStream ? createOpenAISseBody(decoded, protocol) : createPlainDecodedBody(decoded);
  return rebuildResponse(response, body);
}
