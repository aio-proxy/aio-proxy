import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

import { configPath } from '@aio-proxy/core';
import { m } from '@aio-proxy/i18n';

import { resolveAgentExecutable } from '../executable';
import { CliExit, EXIT } from '../exit';
import { serviceEnvFile } from '../service-env';
import { isPlatformCliBinary, resolveUpgradeTargetFrom } from '../upgrade/detect';
import { LAUNCHD_LABEL, renderLaunchdPlist, renderSystemdUnit, SYSTEMD_UNIT_NAME } from './unit-templates';

export { renderLaunchdPlist, renderSystemdUnit } from './unit-templates';
export { resolveAgentExecutable as resolveExec };

export type ServiceInstallOptions = { readonly system?: boolean };
type Printer = (line: string) => void;

type SupportedPlatform = 'darwin' | 'linux';

function requirePlatform(): SupportedPlatform {
  const current = platform();
  if (current === 'darwin' || current === 'linux') return current;
  throw new CliExit(EXIT.unrecoverable, m['cli.service.unsupported_platform']({ platform: current }));
}

function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function systemdUnitPath(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg === undefined || xdg === '' ? join(homedir(), '.config') : xdg;
  return join(base, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

export function managedUnitPath(os: NodeJS.Platform = platform()): string | undefined {
  if (os === 'darwin') return launchdPlistPath();
  if (os === 'linux') return systemdUnitPath();
  return undefined;
}

// Whether a managed unit file exists for the current platform. Callers that only
// want to restart a managed daemon should gate on this first, since a manually
// started daemon (`aio-proxy run`) has no installed unit. Returns false on
// unsupported platforms rather than throwing, since "no managed service" is the
// honest answer there too.
export function isManagedServiceInstalled(): boolean {
  const os = platform();
  if (os === 'darwin') return existsSync(launchdPlistPath());
  if (os === 'linux') return existsSync(systemdUnitPath());
  return false;
}

// Run a manager command, streaming its output. `allowFailure` is for status-style
// probes where a non-zero code means "not running", not a CLI error.
async function runManager(cmd: readonly string[], allowFailure = false): Promise<number> {
  const proc = Bun.spawn(cmd as string[], { stdout: 'inherit', stderr: 'inherit' });
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

// Render and write (or overwrite) the managed unit for the current platform with
// a freshly resolved exec path. Returns the unit path. Shared by install and
// restart: restart must rewrite an existing unit because an install from an
// earlier release — or a `brew upgrade` that retargeted the launcher symlink —
// can leave a stale ExecStart pointing at a now-deleted binary, and a plain
// stop/start would relaunch nothing.
export async function writeManagedUnit(
  os: SupportedPlatform,
  exec: string = resolveAgentExecutable(),
  target: string = os === 'darwin' ? launchdPlistPath() : systemdUnitPath(),
): Promise<string> {
  const cfg = configPath();
  let upgradeMethod: 'brew' | 'bun' | 'npm' | 'pnpm' | undefined;
  try {
    const detected = await resolveUpgradeTargetFrom(exec);
    if (detected.method !== 'binary') upgradeMethod = detected.method;
  } catch {}
  if (upgradeMethod === undefined && isPlatformCliBinary(exec)) {
    try {
      // Install-time PATH still has the JS shim in the manager bin dir even when
      // ExecStart is the native optional-dep binary the shim spawned. Scan PATH
      // directly: Bun.which can miss a launcher added after process start.
      const pathVar = process.env['PATH'];
      if (pathVar !== undefined && pathVar !== '') {
        for (const dir of pathVar.split(':')) {
          if (dir === '') continue;
          const onPath = join(dir, 'aio-proxy');
          if (onPath === exec || !existsSync(onPath)) continue;
          const fromPath = await resolveUpgradeTargetFrom(onPath);
          if (fromPath.method !== 'binary') {
            upgradeMethod = fromPath.method;
            break;
          }
        }
      }
    } catch {}
  }
  const unit = { exec, configPath: cfg, ...(upgradeMethod === undefined ? {} : { upgradeMethod }) };
  const body = os === 'darwin' ? renderLaunchdPlist(unit) : renderSystemdUnit(unit);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body, { mode: 0o644 });
  if (os === 'linux') await runManager(['systemctl', '--user', 'daemon-reload']);
  return target;
}

export async function serviceInstall(options: ServiceInstallOptions = {}, print: Printer = console.log): Promise<void> {
  assertUserScope(options);
  const os = requirePlatform();
  const target = await writeManagedUnit(os);
  if (os === 'linux') await runManager(['systemctl', '--user', 'enable', SYSTEMD_UNIT_NAME]);
  print(m['cli.service.installed']({ path: target }));
  print(m['cli.service.env_hint']({ path: serviceEnvFile(configPath()) }));
}

export async function serviceUninstall(print: Printer = console.log): Promise<void> {
  const os = requirePlatform();
  if (os === 'darwin') {
    const target = launchdPlistPath();
    await runManager(['launchctl', 'unload', '-w', target], true);
    rmSync(target, { force: true });
    print(m['cli.service.uninstalled']({ path: target }));
    return;
  }
  const target = systemdUnitPath();
  await runManager(['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT_NAME], true);
  rmSync(target, { force: true });
  await runManager(['systemctl', '--user', 'daemon-reload']);
  print(m['cli.service.uninstalled']({ path: target }));
}

type ServiceStartIo = Pick<ServiceRestartIo, 'platform' | 'unitInstalled' | 'unitPath' | 'runManager' | 'install'>;

export async function serviceStart(io: ServiceStartIo = {}): Promise<void> {
  const os = io.platform ?? requirePlatform();
  if (os !== 'darwin' && os !== 'linux') {
    throw new CliExit(EXIT.unrecoverable, m['cli.service.unsupported_platform']({ platform: os }));
  }
  const run = io.runManager ?? runManager;
  const installed = (io.unitInstalled ?? isManagedServiceInstalled)();
  try {
    if (!installed) await (io.install ?? serviceInstall)({});
    if (os === 'darwin') {
      // RunAtLoad=true means `load -w` also starts the job.
      await run(['launchctl', 'load', '-w', io.unitPath ?? launchdPlistPath()]);
      return;
    }
    await run(['systemctl', '--user', 'start', SYSTEMD_UNIT_NAME]);
  } catch (error) {
    if (installed) throw error;
    throw new CliExit(
      error instanceof CliExit ? error.code : EXIT.unrecoverable,
      m['cli.service.auto_install_failed']({ reason: error instanceof Error ? error.message : String(error) }),
    );
  }
}

export async function serviceStop(): Promise<void> {
  const os = requirePlatform();
  if (os === 'darwin') {
    await runManager(['launchctl', 'unload', '-w', launchdPlistPath()]);
    return;
  }
  await runManager(['systemctl', '--user', 'stop', SYSTEMD_UNIT_NAME]);
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
};

const isDarwinLaunchdJob = (env: NodeJS.ProcessEnv, isTTY: boolean): boolean =>
  isTTY !== true && (env['XPC_SERVICE_NAME'] === LAUNCHD_LABEL || env['AIO_PROXY_MANAGED'] === '1');

const spawnDarwinRestartHelper = (plist: string, spawn: typeof Bun.spawn): void => {
  const quoted = `'${plist.replaceAll("'", `'\\''`)}'`;
  const script = `sleep 1; /bin/launchctl unload -w ${quoted}; /bin/launchctl load -w ${quoted}`;
  const child = spawn(['/bin/sh', '-c', script], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  });
  child.unref();
};

export async function serviceRestart(io: ServiceRestartIo = {}): Promise<void> {
  const os = io.platform ?? requirePlatform();
  if (os !== 'darwin' && os !== 'linux') {
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
  // Rewrite an already-installed unit with a freshly resolved exec first. A unit
  // installed by an earlier release (or before a `brew upgrade` retargeted the
  // launcher symlink) can hold a stale ExecStart pointing at a deleted binary; on
  // darwin a plain stop/start would then relaunch nothing, so restart must migrate
  // it. Missing units use the full install/start path above, including enable.
  if (io.exec === undefined) await writeUnit(os);
  else await writeUnit(os, io.exec);
  if (os === 'darwin') {
    const plist = io.unitPath ?? launchdPlistPath();
    if (isDarwinLaunchdJob(env, isTTY)) {
      spawnDarwinRestartHelper(plist, io.spawn ?? Bun.spawn);
      return;
    }
    await run(['launchctl', 'unload', '-w', plist]);
    await run(['launchctl', 'load', '-w', plist]);
    return;
  }
  await run(['systemctl', '--user', 'restart', SYSTEMD_UNIT_NAME]);
}

export async function serviceStatus(): Promise<void> {
  const os = requirePlatform();
  // A stopped/missing unit (or an unavailable manager) makes launchctl/systemctl
  // exit nonzero. Forward that code so scripts and health checks can tell an active
  // service from an inactive one; the manager already printed the human-readable
  // result, so signal with an empty message and only the exit code (`transient`
  // maps to a nonzero exit).
  const cmd =
    os === 'darwin' ? ['launchctl', 'list', LAUNCHD_LABEL] : ['systemctl', '--user', 'status', SYSTEMD_UNIT_NAME];
  const code = await runManager(cmd, true);
  if (code !== 0) throw new CliExit(EXIT.transient, '');
}
