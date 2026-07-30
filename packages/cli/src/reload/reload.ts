import { m } from '@aio-proxy/i18n';

import { controlBaseUrl } from '../control-plane';
import { ReloadError } from '../errors';

export type ReloadOptions = {
  readonly host?: string;
  readonly port?: string;
};

export async function reloadCommand(options: ReloadOptions = {}): Promise<void> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? '9317';
  const url = `${controlBaseUrl(host, port)}/admin/reload`;
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5_000) });
  } catch (cause) {
    throw new ReloadError(m.cli_reload_failed({ error: cause instanceof Error ? cause.message : String(cause) }));
  }
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!response.ok || body.ok !== true) {
    throw new ReloadError(m.cli_reload_failed({ error: body.error ?? `HTTP ${response.status}` }));
  }
}
