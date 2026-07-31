import { m } from '@aio-proxy/i18n';

import packageJson from '../../package.json' with { type: 'json' };
import { controlBaseUrl, probeHealth, resolveControlAddress } from '../control-plane';
import { CliExit, EXIT } from '../exit';
import { serviceRestart } from '../service';
import { updateViaBinary } from './binary';
import { NPM_REGISTRY, type UpgradeTarget } from './constants';
import { resolveUpgradeTarget } from './detect';
import { runPackageManagerUpgrade } from './methods';
import { fetchLatestVersion } from './registry';

export type UpgradeOptions = {
  readonly check?: boolean;
  readonly force?: boolean;
  readonly restart?: boolean;
  readonly registry?: string;
};

type UpgradeDeps = {
  readonly resolveTarget: () => Promise<UpgradeTarget>;
  readonly fetchLatest: (registry: string) => Promise<string>;
  readonly currentVersion: string;
};

const defaultDeps: UpgradeDeps = {
  resolveTarget: resolveUpgradeTarget,
  fetchLatest: (registry) => fetchLatestVersion(registry),
  currentVersion: packageJson.version,
};

export const runUpgradeCommand = async (
  options: UpgradeOptions = {},
  print: (line: string) => void = console.log,
  deps: UpgradeDeps = defaultDeps,
): Promise<void> => {
  const registry = options.registry ?? NPM_REGISTRY;
  const target = await deps.resolveTarget();
  let latest: string;
  try {
    latest = await deps.fetchLatest(registry);
  } catch {
    throw new CliExit(EXIT.transient, m.cli_upgrade_check_failed());
  }
  const current = deps.currentVersion;
  print(m.cli_upgrade_current_version({ version: current }));

  const cmp = Bun.semver.order(latest, current);
  if (cmp <= 0 && options.force !== true) {
    print(m.cli_upgrade_up_to_date({ version: current }));
    return;
  }
  if (cmp > 0) print(m.cli_upgrade_new_version({ version: latest }));
  if (options.check === true) return;
  if (cmp <= 0 && options.force === true) print(m.cli_upgrade_forcing({ version: latest }));

  print(m.cli_upgrade_via({ method: target.method }));
  if (target.method === 'binary') await updateViaBinary(target.path, latest);
  else await runPackageManagerUpgrade(target.method, latest, { registry, force: options.force === true });
  print(m.cli_upgrade_success({ version: latest }));

  const { host, port } = await resolveControlAddress({});
  const url = controlBaseUrl(host, port);
  if ((await probeHealth(url)) !== null) {
    if (options.restart === true) {
      print(m.cli_upgrade_restarting());
      await serviceRestart();
    } else {
      print(m.cli_upgrade_daemon_running_hint());
    }
  }
};
