import { m } from '@aio-proxy/i18n';

import { controlBaseUrl, probeHealth, resolveControlAddress } from '../control-plane';
import { StatusNotRunningError } from '../errors';

export type StatusOptions = {
  readonly host?: string;
  readonly port?: string;
  readonly deep?: boolean;
  readonly json?: boolean;
};

type DeepProbeFailure = { readonly reason: 'auth' | 'probe-failed'; readonly status?: number };

type StatusResult = {
  readonly running: boolean;
  readonly url: string;
  readonly version?: string;
  readonly uptime?: number;
  readonly providers?: unknown;
  readonly deepFailure?: DeepProbeFailure;
};

type ProbeResult = { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly status?: number };

// Returns the HTTP status on a non-2xx response so the caller can tell an
// auth-gated dashboard (401/403) apart from other failures (404/500/network).
// A network error / timeout has no status and omits it.
const probeProviders = async (base: string): Promise<ProbeResult> => {
  try {
    const res = await fetch(`${base}/dashboard/api/providers?probe=true`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false };
  }
};

export async function statusCommand(
  options: StatusOptions = {},
  print: (line: string) => void = console.log,
): Promise<void> {
  const { host, port } = await resolveControlAddress(options);
  const url = controlBaseUrl(host, port);
  const health = await probeHealth(url);

  const result: StatusResult = {
    running: health !== null,
    url,
    ...(health?.version === undefined ? {} : { version: health.version }),
    ...(health?.uptime === undefined ? {} : { uptime: health.uptime }),
  };

  if (health === null) {
    if (options.json === true) print(JSON.stringify({ ...result }, undefined, 2));
    else print(m.cli_status_not_running({ url }));
    // Result already printed; signal "down" with a nonzero exit so health checks and
    // service scripts can tell an unreachable daemon apart from a running one without
    // parsing localized output.
    throw new StatusNotRunningError();
  }

  let deepFailure: DeepProbeFailure | undefined;
  let providers: unknown;
  if (options.deep === true) {
    const probe = await probeProviders(url);
    if (probe.ok) providers = probe.data;
    // 401/403 means the dashboard is password-gated; any other status (or a
    // network error with no status) is a generic probe failure.
    else if (probe.status === 401 || probe.status === 403) deepFailure = { reason: 'auth' };
    else deepFailure = { reason: 'probe-failed', ...(probe.status === undefined ? {} : { status: probe.status }) };
  }

  if (options.json === true) {
    print(
      JSON.stringify(
        {
          ...result,
          ...(providers === undefined ? {} : { providers }),
          ...(deepFailure === undefined ? {} : { deepFailure }),
        },
        undefined,
        2,
      ),
    );
    return;
  }

  print(m.cli_status_running({ url, version: health.version ?? 'unknown' }));
  if (options.deep === true) {
    if (deepFailure === undefined) print(JSON.stringify(providers, undefined, 2));
    else if (deepFailure.reason === 'auth') print(m.cli_status_deep_unavailable());
    else print(m.cli_status_deep_probe_failed({ status: String(deepFailure.status ?? 'network error') }));
  }
}
