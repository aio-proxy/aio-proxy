export type Health = { readonly status?: string; readonly uptime?: number; readonly version?: string };

// Bracket an IPv6 authority so `--host ::1` yields http://[::1]:9317 instead of
// the invalid http://::1:9317 (which would make every control-plane probe fail).
export const controlBaseUrl = (host: string, port: string): string =>
  `http://${host.includes(':') ? `[${host}]` : host}:${port}`;

// Probe the daemon's /health. Only accept a response that carries aio-proxy's
// own `status: "ok"` marker, so an unrelated service answering /health on the
// same port is not mistaken for a running proxy. A non-2xx, non-JSON, or
// unmarked body — like a network error — reports "not running" (null).
export const probeHealth = async (base: string): Promise<Health | null> => {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (typeof data !== 'object' || data === null) return null;
    const health = data as Health;
    return health.status === 'ok' ? health : null;
  } catch {
    return null;
  }
};
