import { m } from '@aio-proxy/i18n';

import { controlBaseUrl, resolveControlAddress } from '../control-plane';
import { ReloadError } from '../errors';

export type ReloadOptions = {
  readonly host?: string;
  readonly port?: string;
};

export async function reloadCommand(options: ReloadOptions = {}): Promise<void> {
  const { host, port } = await resolveControlAddress(options);
  const url = `${controlBaseUrl(host, port)}/admin/reload`;
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5_000) });
  } catch (cause) {
    // No response at all (daemon down, timeout, connection reset): retrying may succeed.
    throw new ReloadError(m.cli_reload_failed({ error: cause instanceof Error ? cause.message : String(cause) }), true);
  }
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!response.ok || body.ok !== true) {
    // 5xx is a transient server-side fault (retry); a 409 (invalid config) or other 4xx is
    // a terminal reload rejection that will not succeed until the operator fixes the config.
    const transient = response.status >= 500;
    throw new ReloadError(m.cli_reload_failed({ error: body.error ?? `HTTP ${response.status}` }), transient);
  }
}
