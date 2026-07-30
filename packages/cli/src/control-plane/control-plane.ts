import { AtomicConfigFile, configPath, parseRuntimeConfig } from '@aio-proxy/core';

import { loadServiceEnv } from '../service-env';

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
export async function resolveControlAddress(options: { readonly host?: string; readonly port?: string }): Promise<{
  readonly host: string;
  readonly port: string;
}> {
  if (options.host !== undefined && options.port !== undefined) {
    return { host: options.host, port: options.port };
  }
  let configured: { host?: string; port?: number } = {};
  try {
    const path = configPath();
    loadServiceEnv(path);
    const config = parseRuntimeConfig(await new AtomicConfigFile(path).read());
    configured = { host: config.server.host, port: config.server.port };
  } catch {
    // Unreadable / malformed / not-yet-created config: keep the loopback defaults.
  }
  return {
    host: options.host ?? configured.host ?? DEFAULT_CONTROL_HOST,
    port: options.port ?? (configured.port === undefined ? DEFAULT_CONTROL_PORT : String(configured.port)),
  };
}

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
