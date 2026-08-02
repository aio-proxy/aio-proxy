export type ProviderFetch = typeof globalThis.fetch;

type ProxyInit = Parameters<ProviderFetch>[1] & { proxy?: string };

/**
 * Strips request-side framing headers so fetch recomputes them for the
 * buffered, fixed-length body. Forwarding a stale `transfer-encoding: chunked`
 * or a `content-length` computed for the original stream would mismatch the
 * materialized body.
 */
function stripFramingHeaders(headers: Headers): void {
  headers.delete('content-length');
  headers.delete('transfer-encoding');
}

/**
 * Wraps a fetch implementation to route requests through a URL-only HTTP(S)
 * proxy via Bun's `proxy` fetch option. Returns the implementation unchanged
 * when no proxy is configured so callers pay no overhead in the common case.
 *
 * Bun 1.3.x silently drops a `ReadableStream` request body when `fetch` is
 * given the `proxy` option, which hangs proxied streaming passthrough for
 * `api` providers until timeout. We materialize a streamed request body to a
 * buffer before delegating so the body survives the proxied request. The body
 * can arrive either on `init.body` (Anthropic/Gemini pass the fetcher through
 * directly) or on a `Request` passed as `input` (the OpenAI stream-fetch folds
 * the body onto a Request, leaving `init.body` undefined). Both shapes are
 * buffered. Only the request body is buffered; the response is returned
 * untouched and stays streaming.
 *
 * TODO(bun-1.4.0, issue #128): Bun 1.4.0 fixes this proxy body drop. Once the
 * toolchain is pinned to Bun >= 1.4.0, delete the `ReadableStream` buffering
 * branches below and restore the direct passthrough:
 *   return ((input, init) => fetchImpl(input, { ...init, proxy })) as ProviderFetch;
 * (the wrapper can also go back to being non-async).
 */
export function createProxyFetch(
  proxy: string | undefined,
  fetchImpl: ProviderFetch = globalThis.fetch,
): ProviderFetch {
  if (proxy === undefined) return fetchImpl;
  return (async (input: Parameters<ProviderFetch>[0], init?: Parameters<ProviderFetch>[1]) => {
    // TODO(bun-1.4.0, issue #128): remove this buffering branch when on Bun >= 1.4.0.
    if (init?.body instanceof ReadableStream) {
      const body = await new Response(init.body).arrayBuffer();
      return fetchImpl(input, { ...init, body, proxy });
    }
    // TODO(bun-1.4.0, issue #128): remove this buffering branch when on Bun >= 1.4.0.
    // OpenAI-protocol passthrough folds the streaming body onto a Request input
    // (via `new Request(input, init)`), so `init.body` is undefined here.
    if (input instanceof Request && input.body instanceof ReadableStream) {
      const body = await input.arrayBuffer();
      // Merge the Request's own headers with the caller's init headers (init
      // wins on conflicts), then strip framing headers so fetch recomputes
      // them for the fixed-length buffered body.
      const headers = new Headers(input.headers);
      if (init?.headers !== undefined) {
        new Headers(init.headers).forEach((value, key) => headers.set(key, value));
      }
      stripFramingHeaders(headers);
      // Base the outgoing init on the Request's own method/signal, then let the
      // caller's init (e.g. `decompress`) win via the spread — preserving
      // unknown Bun-specific fields — then pin the merged headers, buffered
      // body, and proxy.
      const outgoing: ProxyInit = {
        method: input.method,
        signal: input.signal,
        ...init,
        headers,
        body,
        proxy,
      };
      return fetchImpl(input.url, outgoing);
    }
    return fetchImpl(input, { ...init, proxy });
  }) as ProviderFetch;
}
