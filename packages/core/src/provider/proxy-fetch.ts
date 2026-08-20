export type ProviderFetch = typeof globalThis.fetch;

/**
 * Wraps a fetch implementation to route requests through a URL-only HTTP(S)
 * proxy via Bun's `proxy` fetch option. Returns the implementation unchanged
 * when no proxy is configured so callers pay no overhead in the common case.
 */
export function createProxyFetch(
  proxy: string | undefined,
  fetchImpl: ProviderFetch = globalThis.fetch,
): ProviderFetch {
  if (proxy === undefined) return fetchImpl;
  return ((input, init) => fetchImpl(input, { ...init, proxy })) as ProviderFetch;
}
