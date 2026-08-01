import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { configPath } from '@aio-proxy/core';
import { m } from '@aio-proxy/i18n';

import { CliExit, EXIT } from '../exit';
import { serviceEnvFile } from '../service-env';
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

// Resolve the single executable the service manager should launch. The npm
// `aio-proxy` bin on PATH is a Node shim (`#!/usr/bin/env node`) that spawns the
// platform-native binary; a managed run (launchd/systemd) has a minimal PATH
// without node, so pointing ExecStart at the shim fails before the real binary
// starts.
//
// A brew (or any symlinked) install instead exposes a stable launcher on PATH
// (`/opt/homebrew/bin/aio-proxy`) that symlinks to the *versioned* binary
// (`.../Cellar/aio-proxy/0.3.0/bin/aio-proxy`), which is also what execPath
// resolves to. Baking that versioned execPath is what breaks `service restart`
// after `brew upgrade`: brew deletes the old Cellar dir and retargets the
// symlink, leaving ExecStart pointing at a binary that no longer exists. So when
// the PATH launcher resolves to the same binary we're running as, prefer that
// stable path — it follows the symlink across upgrades.
//
// Otherwise fall back to the self-contained native binary we already ARE
// (execPath) — but only if it still exists. An in-process `aio-proxy upgrade` on
// brew deletes the old Cellar execPath mid-run while retargeting the launcher
// symlink to the new binary, so a now-deleted execPath must defer to the PATH
// launcher (the live install) instead of baking a path that no longer exists.
// Only when execPath is an interpreter (dev `bun run`) or gone do we resolve via
// PATH, failing fast if even that is missing rather than render `ExecStart=<bun>
// run`, which would invoke bun's own `run` subcommand and never start.
// which/execPath/realpath/exists are injectable to keep this testable.
// ponytail: no AVX2/musl variant probing like opencode — we ship one binary per
// platform with no variants, so execPath basename is enough.
export function resolveExec(
  which: (cmd: string) => string | null = Bun.which,
  execPath: string = process.execPath,
  realpath: (p: string) => string = realpathSync,
  exists: (p: string) => boolean = existsSync,
): string {
  // realpath both so a symlinked launcher (brew) matches the versioned target
  // execPath resolves to; swallow ENOENT so a stale/broken link can't crash us.
  const sameBinary = (a: string, b: string): boolean => {
    try {
      return realpath(a) === realpath(b);
    } catch {
      return a === b;
    }
  };
  const onPath = which('aio-proxy');
  if (onPath !== null && sameBinary(onPath, execPath)) return onPath;
  if (basename(execPath) === 'aio-proxy' && exists(execPath)) return execPath;
  if (onPath !== null) return onPath;
  throw new CliExit(EXIT.unrecoverable, m.cli_service_exec_not_found());
}

function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function systemdUnitPath(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg === undefined || xdg === '' ? join(homedir(), '.config') : xdg;
  return join(base, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

// Whether a managed unit file exists for the current platform. `serviceRestart`
// invokes launchctl/systemctl unconditionally, which errors when the daemon was
// started manually (`aio-proxy run`) with no installed unit; callers that only
// want to restart a managed daemon should gate on this first. Returns false on
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

// Render and write (or overwrite) the managed unit for the current platform with
// a freshly resolved exec path. Returns the unit path. Shared by install and
// restart: restart must rewrite an existing unit because an install from an
// earlier release — or a `brew upgrade` that retargeted the launcher symlink —
// can leave a stale ExecStart pointing at a now-deleted binary, and a plain
// stop/start would relaunch nothing.
export async function writeManagedUnit(
  os: SupportedPlatform,
  exec: string = resolveExec(),
  target: string = os === 'darwin' ? launchdPlistPath() : systemdUnitPath(),
): Promise<string> {
  const cfg = configPath();
  const body =
    os === 'darwin' ? renderLaunchdPlist({ exec, configPath: cfg }) : renderSystemdUnit({ exec, configPath: cfg });
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
  print(m.cli_service_installed({ path: target }));
  print(m.cli_service_env_hint({ path: serviceEnvFile(configPath()) }));
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
  await runManager(['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT_NAME], true);
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
  // Rewrite an already-installed unit with a freshly resolved exec first. A unit
  // installed by an earlier release (or before a `brew upgrade` retargeted the
  // launcher symlink) can hold a stale ExecStart pointing at a deleted binary; on
  // darwin a plain stop/start would then relaunch nothing, so restart must migrate
  // it. Only migrate when a unit exists — restart must not create one (that is
  // install's job), or it would leave a partial, un-enabled unit behind.
  if (isManagedServiceInstalled()) await writeManagedUnit(os);
  if (os === 'darwin') {
    await serviceStop();
    await serviceStart();
    return;
  }
  await runManager(['systemctl', '--user', 'restart', SYSTEMD_UNIT_NAME]);
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
