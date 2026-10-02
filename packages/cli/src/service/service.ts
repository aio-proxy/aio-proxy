import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { delimiter as platformDelimiter, dirname, isAbsolute, join, win32 } from 'node:path';

import { configPath } from '@aio-proxy/core';
import { m } from '@aio-proxy/i18n';

import { resolveAgentExecutable } from '../executable';
import { CliExit, EXIT } from '../exit';
import { serviceEnvFile } from '../service-env';
import { createStyle } from '../ui';
import { isPlatformCliBinary, launcherBeside, resolveUpgradeTargetFrom } from '../upgrade/detect';
import {
  BOOTOUT_TIMEOUT_MS,
  bootoutLaunchdJob,
  isDarwinLaunchdJob,
  launchdPlistPath,
  printLaunchdJob,
  spawnDarwinRestartHelper,
  startLaunchdJob,
} from './launchd';
import { isManagedServiceInstalled } from './managed-unit';
import {
  defaultSchtasksIo,
  exitProcessLater,
  schtasksInstall,
  schtasksRestart,
  schtasksRestartInService,
  schtasksStart,
  schtasksStatus,
  schtasksStop,
  schtasksUninstall,
} from './schtasks';
import { serviceSpecPath } from './schtasks-unit';
import { systemdUnitPath } from './systemd';
import { clearUninstallMarker, writeUninstallMarker } from './uninstall-marker';
import {
  LAUNCHD_LABEL,
  renderLaunchdPlist,
  renderSystemdUnit,
  SYSTEMD_UNIT_NAME,
  type UnitOptions,
} from './unit-templates';

export { launchdDomain, launchdJobTarget } from './launchd';
export { isManagedServiceInstalled, managedUnitPath, readDesktopOwnedUnit } from './managed-unit';
export { renderLaunchdPlist, renderSystemdUnit } from './unit-templates';
export { resolveAgentExecutable as resolveExec };

export type ServiceInstallOptions = { readonly system?: boolean };
type Printer = (line: string) => void;

type SupportedPlatform = 'darwin' | 'linux' | 'win32';

// Service managers do not inherit the user's shell PATH. Keep the configured
// command directories across restarts, including upgrades initiated by the daemon.
// The home fallbacks also migrate older units that had no PATH entry at all.
export const managedServicePath = (
  home: string,
  inherited: string | undefined,
  delimiter: string = platformDelimiter,
): string => {
  const userBins = ['.opencode/bin', '.npm-global/bin', '.local/bin', '.local/bin/node/bin', '.grok/bin', '.bun/bin'];
  // Windows entries use win32 path rules even when computed off-Windows (tests); the POSIX fallback dirs do not apply.
  const win = delimiter === ';';
  const join_ = win ? win32.join : join;
  const abs = win ? win32.isAbsolute : isAbsolute;
  const dirs = [
    ...(inherited?.split(delimiter) ?? []),
    ...userBins.map((suffix) => join_(home, suffix)),
    ...(win ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']),
  ];
  return [...new Set(dirs.filter(abs))].join(delimiter);
};

function requirePlatform(): SupportedPlatform {
  const current = platform();
  if (current === 'darwin' || current === 'linux' || current === 'win32') return current;
  throw new CliExit(EXIT.unrecoverable, m['cli.service.unsupported_platform']({ platform: current }));
}

// Run a manager command, streaming its output. `allowFailure` is for status-style
// probes where a non-zero code means "not running", not a CLI error.
async function runManager(cmd: readonly string[], allowFailure = false): Promise<number> {
  const proc = Bun.spawn(cmd as string[], { stdout: 'inherit', stderr: 'inherit', windowsHide: true });
  const code = await proc.exited;
  if (code !== 0 && !allowFailure) {
    throw new CliExit(EXIT.transient, m['cli.service.command_failed']({ command: cmd.join(' '), code }));
  }
  return code;
}

function assertUserScope(options: ServiceInstallOptions): void {
  if (options.system === true) {
    // ponytail: user-scope only; system-scope (root, LaunchDaemons/etc-systemd)
    // deferred until a maintainer signs off on privileged installs.
    throw new CliExit(EXIT.unrecoverable, m['cli.service.system_unsupported']());
  }
}

// The unit every platform writes for `exec`: its environment, PATH and how the daemon upgrades itself.
export async function resolveUnitOptions(
  os: SupportedPlatform,
  exec: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UnitOptions> {
  const desktopExec = env['AIO_PROXY_DESKTOP_EXEC'];
  const desktopOwned = desktopExec !== undefined && desktopExec !== '' && exec === desktopExec;
  // Windows spells it `Path`; a copied env object loses the case-insensitive lookup.
  const pathVar = env['PATH'] ?? env['Path'];
  const delimiter = os === 'win32' ? ';' : ':';
  let upgradeMethod: UnitOptions['upgradeMethod'];
  if (desktopOwned) {
    // Sparkle updates the bundle behind the symlink; no package manager or binary self-update may touch it.
    upgradeMethod = 'desktop';
  } else {
    try {
      const detected = await resolveUpgradeTargetFrom(exec, process.env, {}, os);
      if (detected.method !== 'binary') upgradeMethod = detected.method;
    } catch {}
    if (upgradeMethod === undefined && isPlatformCliBinary(exec)) {
      try {
        // Install-time PATH still has the JS shim in the manager bin dir even when
        // ExecStart is the native optional-dep binary the shim spawned. Scan PATH
        // directly: Bun.which can miss a launcher added after process start.
        if (pathVar !== undefined && pathVar !== '') {
          for (const dir of pathVar.split(delimiter)) {
            if (dir === '') continue;
            const onPath = launcherBeside(join(dir, 'aio-proxy'), os);
            if (onPath === undefined || onPath === exec) continue;
            const fromPath = await resolveUpgradeTargetFrom(onPath, process.env, {}, os);
            if (fromPath.method !== 'binary') {
              upgradeMethod = fromPath.method;
              break;
            }
          }
        }
      } catch {}
    }
  }
  return {
    exec,
    configPath: configPath(),
    path: managedServicePath(homedir(), pathVar, delimiter),
    ...(upgradeMethod === undefined ? {} : { upgradeMethod }),
    ...(desktopOwned ? { desktopExec } : {}),
  };
}

// Render and write (or overwrite) the managed unit for the current platform with
// a freshly resolved exec path. Returns the unit path. Shared by install and
// restart: restart must rewrite an existing unit because an install from an
// earlier release — or a `brew upgrade` that retargeted the launcher symlink —
// can leave a stale ExecStart pointing at a now-deleted binary, and a plain
// stop/start would relaunch nothing.
export async function writeManagedUnit(
  os: Exclude<SupportedPlatform, 'win32'>,
  exec: string = resolveAgentExecutable(),
  target: string = os === 'darwin' ? launchdPlistPath() : systemdUnitPath(),
  env: NodeJS.ProcessEnv = process.env,
  run: typeof runManager = runManager,
): Promise<string> {
  const unit = await resolveUnitOptions(os, exec, env);
  const body = os === 'darwin' ? renderLaunchdPlist(unit) : renderSystemdUnit(unit);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body, { mode: 0o644 });
  if (os === 'linux') await run(['systemctl', '--user', 'daemon-reload']);
  return target;
}

// On Windows the task XML and service.json are the unit; they are written together by the schtasks backend.
const windowsIo = (run: ServiceRestartIo['runManager'] = runManager, exec?: string, env = process.env) =>
  defaultSchtasksIo(run, () => resolveUnitOptions('win32', exec ?? resolveAgentExecutable(), env), env);

type ServiceLifecycleIo = {
  readonly platform?: SupportedPlatform;
  readonly runManager?: ServiceRestartIo['runManager'];
  // Injected so install does not depend on whether this host has an `aio-proxy` on PATH.
  readonly exec?: string;
};

export async function serviceInstall(
  options: ServiceInstallOptions = {},
  print: Printer = console.log,
  io: ServiceLifecycleIo = {},
): Promise<void> {
  assertUserScope(options);
  const os = io.platform ?? requirePlatform();
  const run = io.runManager ?? runManager;
  let target: string;
  if (os === 'win32') {
    const winIo = await windowsIo(undefined, io.exec);
    await schtasksInstall(winIo);
    target = serviceSpecPath(winIo.localAppData);
  } else {
    clearUninstallMarker(os);
    target = await writeManagedUnit(os, io.exec, undefined, process.env, run);
  }
  if (os === 'linux') await run(['systemctl', '--user', 'enable', SYSTEMD_UNIT_NAME]);
  print(`${createStyle(process.stdout).mark('ok')} ${m['cli.service.installed']({ path: target })}`);
  print(m['cli.service.env_hint']({ path: serviceEnvFile(configPath()) }));
}

export async function serviceUninstall(print: Printer = console.log, io: ServiceLifecycleIo = {}): Promise<void> {
  const os = io.platform ?? requirePlatform();
  const run = io.runManager ?? runManager;
  if (os === 'win32') {
    const io = await windowsIo();
    await schtasksUninstall(io);
    print(
      `${createStyle(process.stdout).mark('ok')} ${m['cli.service.uninstalled']({ path: serviceSpecPath(io.localAppData) })}`,
    );
    return;
  }
  if (os === 'darwin') {
    const target = launchdPlistPath();
    await runManager(['launchctl', 'unload', '-w', target], true);
    rmSync(target, { force: true });
    print(`${createStyle(process.stdout).mark('ok')} ${m['cli.service.uninstalled']({ path: target })}`);
    return;
  }
  const target = systemdUnitPath();
  await run(['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT_NAME], true);
  rmSync(target, { force: true });
  writeUninstallMarker('linux');
  await run(['systemctl', '--user', 'daemon-reload']);
  print(`${createStyle(process.stdout).mark('ok')} ${m['cli.service.uninstalled']({ path: target })}`);
}

type ServiceStartIo = Pick<
  ServiceRestartIo,
  'platform' | 'unitInstalled' | 'unitPath' | 'runManager' | 'install' | 'printJob'
>;

export async function serviceStart(io: ServiceStartIo = {}): Promise<void> {
  const os = io.platform ?? requirePlatform();
  if (os !== 'darwin' && os !== 'linux' && os !== 'win32') {
    throw new CliExit(EXIT.unrecoverable, m['cli.service.unsupported_platform']({ platform: os }));
  }
  const run = io.runManager ?? runManager;
  const installed = (io.unitInstalled ?? isManagedServiceInstalled)();
  try {
    if (!installed) await (io.install ?? serviceInstall)({});
    if (os === 'darwin') {
      await startLaunchdJob(io.unitPath ?? launchdPlistPath(), run, io.printJob ?? printLaunchdJob);
      return;
    }
    if (os === 'win32') {
      await schtasksStart(await windowsIo(run));
      return;
    }
    // enable --now: a later stop disables, so start must re-enable or the service stays off after reboot.
    await run(['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT_NAME]);
  } catch (error) {
    if (installed) throw error;
    throw new CliExit(
      error instanceof CliExit ? error.code : EXIT.unrecoverable,
      m['cli.service.auto_install_failed']({ reason: error instanceof Error ? error.message : String(error) }),
    );
  }
}

export async function serviceStop(io: ServiceLifecycleIo = {}): Promise<void> {
  const os = io.platform ?? requirePlatform();
  const run = io.runManager ?? runManager;
  if (os === 'darwin') {
    await runManager(['launchctl', 'unload', '-w', launchdPlistPath()]);
    return;
  }
  if (os === 'win32') {
    await schtasksStop(await windowsIo());
    return;
  }
  // disable --now: a plain stop would let the unit's WantedBy start it again at the next login.
  await run(['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT_NAME]);
}

export type ServiceRestartIo = {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly unitInstalled?: () => boolean;
  readonly install?: typeof serviceInstall;
  readonly unitPath?: string;
  readonly exec?: string;
  readonly writeManagedUnit?: typeof writeManagedUnit;
  readonly spawn?: typeof Bun.spawn;
  readonly runManager?: (cmd: readonly string[], allowFailure?: boolean) => Promise<number>;
  /** Exit code of `launchctl print <job>`; 0 while launchd holds the job. Injected by tests. */
  readonly printJob?: () => Promise<number>;
  /** How long `service restart` waits for `bootout` to remove the job. Injected by tests. */
  readonly bootoutTimeoutMs?: number;
  /** Moves the staged plist over the installed one. Injected by tests. */
  readonly replaceUnit?: (staged: string, plist: string) => void;
  /** Ends the process after the restart returned (Windows in-service restart). Injected by tests. */
  readonly scheduleExit?: (code: number, ms: number) => void;
};

export async function serviceRestart(io: ServiceRestartIo = {}): Promise<void> {
  const os = io.platform ?? requirePlatform();
  if (os !== 'darwin' && os !== 'linux' && os !== 'win32') {
    throw new CliExit(EXIT.unrecoverable, m['cli.service.unsupported_platform']({ platform: os }));
  }
  const env = io.env ?? process.env;
  const isTTY = io.isTTY ?? process.stdin.isTTY === true;
  const unitInstalled = io.unitInstalled ?? isManagedServiceInstalled;
  const writeUnit = io.writeManagedUnit ?? writeManagedUnit;
  const run = io.runManager ?? runManager;
  if (!unitInstalled()) {
    await serviceStart({ ...io, platform: os, unitInstalled: () => false });
    return;
  }
  if (os === 'win32') {
    const winIo = await windowsIo(run, io.exec, env);
    // Same shape as `isDarwinLaunchdJob`: the scheduled task's own proxy must not `/End` itself.
    if (env['AIO_PROXY_MANAGED'] === '1' && isTTY !== true) {
      await schtasksRestartInService(winIo, io.scheduleExit ?? exitProcessLater);
    } else {
      await schtasksRestart(winIo);
    }
    return;
  }
  // Rewrite an already-installed unit with a freshly resolved exec first. A unit
  // installed by an earlier release (or before a `brew upgrade` retargeted the
  // launcher symlink) can hold a stale ExecStart pointing at a deleted binary; on
  // darwin a plain stop/start would then relaunch nothing, so restart must migrate
  // it. Missing units use the full install/start path above, including enable.
  const write = () => (io.exec === undefined ? writeUnit(os) : writeUnit(os, io.exec));
  if (os === 'darwin') {
    const plist = io.unitPath ?? launchdPlistPath();
    if (isDarwinLaunchdJob(env, isTTY)) {
      await write();
      spawnDarwinRestartHelper(plist, io.spawn ?? Bun.spawn);
      return;
    }
    // bootout + bootstrap re-reads the rewritten plist; kickstart -k would restart the old definition.
    // The new plist is staged beside the old one first, so a write that fails (read-only file, ACL,
    // full disk) fails while the job still runs. The bootout comes before the swap: one that times
    // out leaves the plist as it was, rather than rewritten while launchd still holds the old
    // definition (the desktop app retries a takeover only while the plist names the old binary).
    const printJob = io.printJob ?? printLaunchdJob;
    const staged = `${plist}.new`;
    await writeUnit(os, io.exec, staged);
    try {
      await bootoutLaunchdJob(run, printJob, io.bootoutTimeoutMs ?? BOOTOUT_TIMEOUT_MS);
    } catch (error) {
      rmSync(staged, { force: true });
      throw error;
    }
    try {
      (io.replaceUnit ?? renameSync)(staged, plist);
    } catch (error) {
      // Bring the old definition back rather than leave the proxy offline.
      await startLaunchdJob(plist, run, printJob);
      throw error;
    }
    await startLaunchdJob(plist, run, printJob);
    return;
  }
  await write();
  await run(['systemctl', '--user', 'enable', SYSTEMD_UNIT_NAME]);
  await run(['systemctl', '--user', 'restart', SYSTEMD_UNIT_NAME]);
}

export async function serviceStatus(): Promise<void> {
  const os = requirePlatform();
  // A stopped/missing unit (or an unavailable manager) makes launchctl/systemctl
  // exit nonzero. Forward that code so scripts and health checks can tell an active
  // service from an inactive one; the manager already printed the human-readable
  // result, so signal with an empty message and only the exit code (`transient`
  // maps to a nonzero exit).
  const code =
    os === 'win32'
      ? await schtasksStatus(await windowsIo())
      : await runManager(
          os === 'darwin' ? ['launchctl', 'list', LAUNCHD_LABEL] : ['systemctl', '--user', 'status', SYSTEMD_UNIT_NAME],
          true,
        );
  if (code !== 0) throw new CliExit(EXIT.transient, '');
}
