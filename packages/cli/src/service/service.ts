import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

import { configPath } from '@aio-proxy/core';
import { m } from '@aio-proxy/i18n';

import { CliExit, EXIT } from '../exit';
import { LAUNCHD_LABEL, renderLaunchdPlist, renderSystemdUnit, SYSTEMD_UNIT_NAME } from './unit-templates';

export { renderLaunchdPlist, renderSystemdUnit } from './unit-templates';

export type ServiceInstallOptions = { readonly system?: boolean };
type Printer = (line: string) => void;

type SupportedPlatform = 'darwin' | 'linux';

function requirePlatform(): SupportedPlatform {
  const current = platform();
  if (current === 'darwin' || current === 'linux') return current;
  throw new CliExit(EXIT.unrecoverable, m.cli_service_unsupported_platform({ platform: current }));
}

// Resolve the single executable the service manager should launch. A globally
// installed npm package exposes an `aio-proxy` bin on PATH. If it is missing we
// fail fast rather than fall back to the interpreter path: `ExecStart=<bun> run`
// would invoke bun's own `run` subcommand (which needs a file argument) and the
// service would never start. `which` is injectable to keep the guard testable.
export function resolveExec(which: (cmd: string) => string | null = Bun.which): string {
  const exec = which('aio-proxy');
  if (exec === null) throw new CliExit(EXIT.unrecoverable, m.cli_service_exec_not_found());
  return exec;
}

function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function systemdUnitPath(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg === undefined || xdg === '' ? join(homedir(), '.config') : xdg;
  return join(base, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

// Run a manager command, streaming its output. `allowFailure` is for status-style
// probes where a non-zero code means "not running", not a CLI error.
async function runManager(cmd: readonly string[], allowFailure = false): Promise<number> {
  const proc = Bun.spawn(cmd as string[], { stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0 && !allowFailure) {
    throw new CliExit(EXIT.transient, m.cli_service_command_failed({ command: cmd.join(' '), code }));
  }
  return code;
}

function assertUserScope(options: ServiceInstallOptions): void {
  if (options.system === true) {
    // ponytail: user-scope only; system-scope (root, LaunchDaemons/etc-systemd)
    // deferred until a maintainer signs off on privileged installs.
    throw new CliExit(EXIT.unrecoverable, m.cli_service_system_unsupported());
  }
}

export async function serviceInstall(options: ServiceInstallOptions = {}, print: Printer = console.log): Promise<void> {
  assertUserScope(options);
  const os = requirePlatform();
  const exec = resolveExec();
  const cfg = configPath();
  if (os === 'darwin') {
    const target = launchdPlistPath();
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderLaunchdPlist({ exec, configPath: cfg }), { mode: 0o644 });
    print(m.cli_service_installed({ path: target }));
    return;
  }
  const target = systemdUnitPath();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderSystemdUnit({ exec, configPath: cfg }), { mode: 0o644 });
  await runManager(['systemctl', '--user', 'daemon-reload']);
  await runManager(['systemctl', '--user', 'enable', SYSTEMD_UNIT_NAME]);
  print(m.cli_service_installed({ path: target }));
}

export async function serviceUninstall(print: Printer = console.log): Promise<void> {
  const os = requirePlatform();
  if (os === 'darwin') {
    const target = launchdPlistPath();
    await runManager(['launchctl', 'unload', '-w', target], true);
    rmSync(target, { force: true });
    print(m.cli_service_uninstalled({ path: target }));
    return;
  }
  const target = systemdUnitPath();
  await runManager(['systemctl', '--user', 'disable', SYSTEMD_UNIT_NAME], true);
  rmSync(target, { force: true });
  await runManager(['systemctl', '--user', 'daemon-reload']);
  print(m.cli_service_uninstalled({ path: target }));
}

export async function serviceStart(): Promise<void> {
  const os = requirePlatform();
  if (os === 'darwin') {
    // RunAtLoad=true means `load -w` also starts the job.
    await runManager(['launchctl', 'load', '-w', launchdPlistPath()]);
    return;
  }
  await runManager(['systemctl', '--user', 'start', SYSTEMD_UNIT_NAME]);
}

export async function serviceStop(): Promise<void> {
  const os = requirePlatform();
  if (os === 'darwin') {
    await runManager(['launchctl', 'unload', '-w', launchdPlistPath()]);
    return;
  }
  await runManager(['systemctl', '--user', 'stop', SYSTEMD_UNIT_NAME]);
}

export async function serviceRestart(): Promise<void> {
  const os = requirePlatform();
  if (os === 'darwin') {
    await serviceStop();
    await serviceStart();
    return;
  }
  await runManager(['systemctl', '--user', 'restart', SYSTEMD_UNIT_NAME]);
}

export async function serviceStatus(): Promise<void> {
  const os = requirePlatform();
  if (os === 'darwin') {
    await runManager(['launchctl', 'list', LAUNCHD_LABEL], true);
    return;
  }
  await runManager(['systemctl', '--user', 'status', SYSTEMD_UNIT_NAME], true);
}
