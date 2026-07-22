import type { ProviderFetch } from "./proxy-fetch";

export const OPENAI_RESPONSES_TERMINAL =
  'data: {"type":"response.completed","response":{"incomplete_details":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
export const OPENAI_COMPATIBLE_TERMINAL =
  'data: {"id":"chatcmpl-test","created":0,"model":"gpt-test","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n";

export function terminalThenErrorFetch(options: { readonly terminal: string; readonly contentEncoding?: "zstd" }) {
  const plain = new TextEncoder().encode(options.terminal);
  const body = options.contentEncoding === "zstd" ? Bun.zstdCompressSync(plain) : plain;
  let acceptEncodingSeen: string | null = null;
  let decompressSeen: boolean | undefined;
  let pulls = 0;
  let wasCancelled = false;

  const fetch = (async (input, init) => {
    const request = new Request(input, init);
    acceptEncodingSeen = request.headers.get("accept-encoding");
    decompressSeen = (init as { decompress?: boolean } | undefined)?.decompress;
    const headers = new Headers({
      "content-length": String(body.byteLength),
      "content-type": "text/event-stream",
    });
    if (options.contentEncoding !== undefined) headers.set("content-encoding", options.contentEncoding);
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(body);
              return;
            }
            controller.error(new TypeError("error decoding response body"));
          },
          cancel() {
            wasCancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      { headers },
    );
  }) as ProviderFetch;

  return {
    fetch,
    acceptEncoding: () => acceptEncodingSeen,
    decompress: () => decompressSeen,
    secondPulls: () => Math.max(0, pulls - 1),
    cancelled: () => wasCancelled,
  };
}
