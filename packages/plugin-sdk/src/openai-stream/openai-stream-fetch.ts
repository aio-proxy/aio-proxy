import { createContentDecodedReader, type ContentDecodedReader } from "./content-decoding";
import { createOpenAISseBody, type OpenAIStreamProtocol } from "./sse-terminal";

export type { OpenAIStreamProtocol } from "./sse-terminal";

const OPENAI_ACCEPT_ENCODING = "gzip, deflate, br, zstd" as const;

type BunFetchInit = RequestInit & { decompress?: boolean };

export function createOpenAIStreamFetch(
  protocol: OpenAIStreamProtocol,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const streamFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
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

function isEventStream(contentType: string | null): boolean {
  return (contentType ?? "").toLowerCase().includes("text/event-stream");
}

function createPlainDecodedBody(decoded: ContentDecodedReader): ReadableStream<Uint8Array> {
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      const read = await decoded.read();
      for (const chunk of read.chunks) controller.enqueue(chunk);
      if (read.error !== undefined) {
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
  const encoding = response.headers.get("content-encoding");
  const source = response.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  // Throws before a Response is returned when Content-Encoding is unsupported.
  const decoded = createContentDecodedReader(source, encoding);
  const body = isEventStream(response.headers.get("content-type"))
    ? createOpenAISseBody(decoded, protocol)
    : createPlainDecodedBody(decoded);
  return rebuildResponse(response, body);
}
