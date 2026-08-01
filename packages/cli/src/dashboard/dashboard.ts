import { m } from '@aio-proxy/i18n';

import { controlBaseUrl, probeHealth, resolveControlAddress } from '../control-plane';
import { StatusNotRunningError } from '../errors';
import { openBrowser as defaultOpenBrowser } from '../open-browser';

export type DashboardOptions = {
  readonly host?: string;
  readonly port?: string;
};

export type DashboardDeps = {
  readonly openBrowser?: (url: string) => boolean;
  readonly print?: (line: string) => void;
  readonly probeHealth?: typeof probeHealth;
  readonly resolveControlAddress?: typeof resolveControlAddress;
};

// Open the running daemon's dashboard in the default browser. Resolve host/port
// the same way as status/doctor so a config-only bind is not mistaken for a down
// daemon. When the daemon is unreachable, print the probe result then signal
// StatusNotRunningError so scripts see a nonzero exit without parsing output.
export async function dashboardCommand(options: DashboardOptions = {}, deps: DashboardDeps = {}): Promise<void> {
  const print = deps.print ?? console.log;
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
  const resolve = deps.resolveControlAddress ?? resolveControlAddress;
  const probe = deps.probeHealth ?? probeHealth;

  const { host, port } = await resolve(options);
  const base = controlBaseUrl(host, port);
  const dashboardUrl = `${base}/dashboard`;
  const health = await probe(base);
  if (health === null) {
    print(m.cli_status_not_running({ url: base }));
    throw new StatusNotRunningError();
  }

  let opened = false;
  try {
    opened = openBrowser(dashboardUrl);
  } catch {
    opened = false;
  }
  if (opened) print(m.cli_dashboard_opened());
  print(dashboardUrl);
}
