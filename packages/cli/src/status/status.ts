import { m } from '@aio-proxy/i18n';

export type StatusOptions = {
  readonly host?: string;
  readonly port?: string;
  readonly deep?: boolean;
  readonly json?: boolean;
};

type Health = { readonly status?: string; readonly uptime?: number; readonly version?: string };

type StatusResult = {
  readonly running: boolean;
  readonly url: string;
  readonly version?: string;
  readonly uptime?: number;
  readonly providers?: unknown;
  readonly deepUnavailable?: boolean;
};

const probeHealth = async (base: string): Promise<Health | null> => {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return null;
    return (await res.json()) as Health;
  } catch {
    return null;
  }
};

const probeProviders = async (base: string): Promise<{ ok: true; data: unknown } | { ok: false }> => {
  try {
    const res = await fetch(`${base}/dashboard/api/providers?probe=true`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { ok: false };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false };
  }
};

export async function statusCommand(
  options: StatusOptions = {},
  print: (line: string) => void = console.log,
): Promise<void> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? '9317';
  const url = `http://${host}:${port}`;
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
    return;
  }

  let deepUnavailable = false;
  let providers: unknown;
  if (options.deep === true) {
    const probe = await probeProviders(url);
    if (probe.ok) providers = probe.data;
    else deepUnavailable = true;
  }

  if (options.json === true) {
    print(
      JSON.stringify(
        {
          ...result,
          ...(providers === undefined ? {} : { providers }),
          ...(deepUnavailable ? { deepUnavailable: true } : {}),
        },
        undefined,
        2,
      ),
    );
    return;
  }

  print(m.cli_status_running({ url, version: health.version ?? 'unknown' }));
  if (options.deep === true) {
    if (deepUnavailable) print(m.cli_status_deep_unavailable());
    else print(JSON.stringify(providers, undefined, 2));
  }
}
