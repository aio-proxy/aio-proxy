import { m } from '@aio-proxy/i18n';

import packageJson from '../../package.json' with { type: 'json' };
import { controlBaseUrl, probeHealth, resolveControlAddress } from '../control-plane';
import { CliExit, EXIT } from '../exit';
import { isManagedServiceInstalled, serviceRestart } from '../service';
import { updateViaBinary } from './binary';
import { NPM_REGISTRY, type UpgradeTarget } from './constants';
import { resolveUpgradeTarget } from './detect';
import { runPackageManagerUpgrade } from './methods';
import { fetchLatestVersion } from './registry';

export type UpgradeOptions = {
  readonly check?: boolean;
  readonly force?: boolean;
  readonly registry?: string;
};

type UpgradeDeps = {
  readonly resolveTarget: () => Promise<UpgradeTarget>;
  readonly fetchLatest: (registry: string) => Promise<string>;
  readonly currentVersion: string;
  readonly install: (target: UpgradeTarget, version: string, options: UpgradeOptions) => Promise<void>;
  // The post-upgrade daemon step is injectable so its branches (managed restart
  // vs. manual-run hint) are testable without real health probing or launchctl.
  readonly isDaemonRunning: () => Promise<boolean>;
  readonly isServiceManaged: () => boolean;
  readonly restartService: () => Promise<void>;
};

const runInstall = async (target: UpgradeTarget, version: string, options: UpgradeOptions): Promise<void> => {
  const registry = options.registry ?? NPM_REGISTRY;
  if (target.method === 'binary') await updateViaBinary(target.path, version, { registry });
  else await runPackageManagerUpgrade(target.method, version, { registry, force: options.force === true });
};

const probeDaemonRunning = async (): Promise<boolean> => {
  const { host, port } = await resolveControlAddress({});
  return (await probeHealth(controlBaseUrl(host, port))) !== null;
};

const defaultDeps: UpgradeDeps = {
  resolveTarget: resolveUpgradeTarget,
  fetchLatest: (registry) => fetchLatestVersion(registry),
  currentVersion: packageJson.version,
  install: runInstall,
  isDaemonRunning: probeDaemonRunning,
  isServiceManaged: isManagedServiceInstalled,
  restartService: serviceRestart,
};

const errorReason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const runUpgradeCommand = async (
  options: UpgradeOptions = {},
  print: (line: string) => void = console.log,
  deps: UpgradeDeps = defaultDeps,
): Promise<void> => {
  const registry = options.registry ?? NPM_REGISTRY;
  // resolveTarget throws when aio-proxy is not on PATH; surface the real reason
  // and an unrecoverable exit code instead of a generic "Unexpected internal error".
  let target: UpgradeTarget;
  try {
    target = await deps.resolveTarget();
  } catch (err) {
    throw new CliExit(EXIT.unrecoverable, m.cli_upgrade_detect_failed({ reason: errorReason(err) }));
  }
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
  // Install failures are plain Errors (package-manager exit code, missing asset);
  // rethrow as CliExit so the user sees the actionable reason, not a generic message.
  try {
    await deps.install(target, latest, options);
  } catch (err) {
    throw new CliExit(EXIT.transient, m.cli_upgrade_install_failed({ reason: errorReason(err) }));
  }
  print(m.cli_upgrade_success({ version: latest }));

  if (!(await deps.isDaemonRunning())) return;
  // A managed daemon (launchd/systemd) is designed to be bounced, so applying the
  // upgrade means restarting it — no opt-in flag. A manually started (`aio-proxy
  // run`) daemon has no unit, so launchctl/systemctl would error; tell the user to
  // restart it themselves instead of failing the upgrade.
  if (!deps.isServiceManaged()) {
    print(m.cli_upgrade_manual_restart_hint());
    return;
  }
  print(m.cli_upgrade_restarting());
  await deps.restartService();
};
