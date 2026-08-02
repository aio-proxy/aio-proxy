export type ProviderFetch = typeof globalThis.fetch;

/**
 * Wraps a fetch implementation to route requests through a URL-only HTTP(S)
 * proxy via Bun's `proxy` fetch option. Returns the implementation unchanged
 * when no proxy is configured so callers pay no overhead in the common case.
 *
 * Bun 1.3.x silently drops a `ReadableStream` request body when `fetch` is
 * given the `proxy` option, which hangs proxied streaming passthrough for
 * `api` providers until timeout. We materialize a streamed request body to a
 * buffer before delegating so the body survives the proxied request. Only the
 * request body is buffered; the response is returned untouched and stays
 * streaming.
 *
 * TODO(bun-1.4.0, issue #128): Bun 1.4.0 fixes this proxy body drop. Once the
 * toolchain is pinned to Bun >= 1.4.0, delete the `ReadableStream` buffering
 * branch below and restore the direct passthrough:
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
    return fetchImpl(input, { ...init, proxy });
  }) as ProviderFetch;
}
