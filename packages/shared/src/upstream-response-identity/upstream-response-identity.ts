// CLI bundles and dynamically loaded plugins can have separate module instances.
const identityStoreKey = Symbol.for('@aio-proxy/shared/upstream-response-identity/v1');
const identityStoreGlobal = globalThis as typeof globalThis & {
  [identityStoreKey]?: WeakMap<Response, object>;
};
const identities = (identityStoreGlobal[identityStoreKey] ??= new WeakMap<Response, object>());

// Keep send identity across response/body rebuilding without retaining either.
export function upstreamResponseIdentity(response: Response): object {
  const existing = identities.get(response);
  if (existing !== undefined) return existing;
  const identity = {};
  identities.set(response, identity);
  return identity;
}

export function inheritUpstreamResponseIdentity(original: Response, wrapped: Response): Response {
  const identity = identities.get(original);
  if (identity !== undefined) identities.set(wrapped, identity);
  return wrapped;
}
