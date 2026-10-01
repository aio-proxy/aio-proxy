import { AtomicConfigFile, canonicalizeLoopbackHost, configPath, parseRuntimeConfig } from '@aio-proxy/core';

import { readServiceEnvironment } from '../service-env';

export type Health = { readonly status?: string; readonly uptime?: number; readonly version?: string };

export const DEFAULT_CONTROL_HOST = '127.0.0.1';
export const DEFAULT_CONTROL_PORT = '9317';

// Resolve the daemon address the control commands (status/reload/doctor) should
// probe: an explicit --host/--port flag always wins; otherwise fall back to the
// managed run's configured server.host/server.port so a config-only bind is not
// mistaken for a down daemon. A missing or malformed config is not fatal here —
// these are read-only probes, so we fall back to the loopback defaults instead of
// throwing. service.env is loaded first (like `run`) so a host template resolving
// against a var defined only there still applies.
export async function resolveControlAddress(
  options: { readonly host?: string; readonly port?: string },
  path: string = configPath(),
): Promise<{
  readonly host: string;
  readonly port: string;
}> {
  if (options.host !== undefined && options.port !== undefined) {
    return { host: options.host, port: options.port };
  }
  let configured: { host?: string; port?: number } = {};
  try {
    const config = parseRuntimeConfig(await new AtomicConfigFile(path).read(), readServiceEnvironment(path));
    configured = { host: config.server.host, port: config.server.port };
  } catch {
    // Unreadable / malformed / not-yet-created config: keep the loopback defaults.
  }
  return {
    host: options.host ?? configured.host ?? DEFAULT_CONTROL_HOST,
    port: options.port ?? (configured.port === undefined ? DEFAULT_CONTROL_PORT : String(configured.port)),
  };
}

// A local client must connect to a literal loopback address: a wildcard bind is not a destination,
// and a hostname or LAN address could route a bearer token off this machine. `localhost` is mapped
// to a literal too, because the desktop client attaches the token only to a literal loopback IP.
export const localControlHost = (host: string): string | undefined => {
  if (host === '' || host === '0.0.0.0' || host === '*' || host === 'localhost') return '127.0.0.1';
  if (host === '::' || host === '[::]') return '::1';
  return canonicalizeLoopbackHost(host);
};

// Bracket an IPv6 authority so `--host ::1` yields http://[::1]:9317 instead of
// the invalid http://::1:9317 (which would make every control-plane probe fail).
export const controlBaseUrl = (host: string, port: string): string =>
  `http://${host.includes(':') ? `[${host}]` : host}:${port}`;

export const codexBaseUrl = (endpoint: string): string => `${endpoint.replace(/\/+$/u, '')}/v1`;

// Probe the daemon's /health. Only accept a response that carries aio-proxy's
// own `status: "ok"` marker, so an unrelated service answering /health on the
// same port is not mistaken for a running proxy. A non-2xx, non-JSON, or
// unmarked body — like a network error — reports "not running" (null).
export const probeHealth = async (
  base: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3_000,
): Promise<Health | null> => {
  try {
    const res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (typeof data !== 'object' || data === null) return null;
    const health = data as Health;
    return health.status === 'ok' ? health : null;
  } catch {
    return null;
  }
};
