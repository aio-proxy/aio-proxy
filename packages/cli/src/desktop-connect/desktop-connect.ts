import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { aioHome, configPathIn, readDesktopToken } from '@aio-proxy/core';
import { isPlainObject } from 'es-toolkit/predicate';

import { controlBaseUrl, localControlHost, probeHealth, resolveControlAddress } from '../control-plane';
import { launchdDomain, launchdJobTarget, managedUnitPath } from '../service';
import { decodeOutput } from '../service/run-capture';
import { processCreationTime, processImagePath, processUserSid, sidForAccount } from '../win32-ffi';
import {
  inspectUnit,
  isRunnable,
  type JobState,
  parseDisabled,
  parseJobPrint,
  type UnitInspection,
  type UnitOwner,
  unitOwner,
} from './launchd-inspect';
import { readTask } from './schtasks-inspect';
import { currentOwner, listSockets, type Socket } from './sockets';
import { readSystemdJob, readSystemdUnit } from './systemd-inspect';
import { verifiedGet } from './verified-get';

const PROBE_TIMEOUT_MS = 2_000;
// The spec bounds the whole command at 10 s. The two HTTP probes take at most 2 s each, so the
// helper processes (plutil, launchctl, systemctl, schtasks, …) share what is left.
const COMMAND_BUDGET_MS = 10_000;
const SPAWN_BUDGET_MS = COMMAND_BUDGET_MS - 2 * PROBE_TIMEOUT_MS;

export type DesktopConnectDeps = {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly bundledVersion: string;
  /** The plist, the systemd unit, or Windows' `service.json`. */
  readonly unitPath: string;
  readonly defaultHome: () => string;
  readonly unitExists: () => boolean;
  /** Whether the unit's target is still something the service manager can run. */
  readonly targetRunnable: (path: string) => boolean;
  /** A process's full image path (win32), to tell the supervisor from any other process with its PID. */
  readonly imagePath: (pid: number) => string | undefined;
  readonly creationTime: (pid: number) => string | undefined;
  /** The SID of a process's account (win32): who owns a socket, by the process netstat names. */
  readonly userSid: (pid: number) => string | undefined;
  /** An account name's SID (win32): the task may name its principal by account. */
  readonly sidForAccount: (account: string) => string | undefined;
  readonly readToken: (home: string) => string | undefined;
  /** This process's account: the listener must belong to it before the token is offered. */
  readonly owner: string;
  readonly run: (cmd: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string }>;
  readonly readFile: (path: string) => Promise<string>;
  readonly fetch: typeof fetch;
  /** The token-bearing identity GET, sent only over a connection this user's process serves. */
  readonly identityGet: (
    host: string,
    port: string,
    path: string,
    token: string,
  ) => Promise<{ readonly status: number; readonly body: string } | undefined>;
};

export type DesktopConnectResult = {
  readonly protocolVersion: 1;
  readonly bundledVersion: string;
  readonly unit: UnitInspection & { readonly owner: UnitOwner };
  readonly job: JobState;
  readonly instance: {
    readonly controlUrl: string | null;
    readonly dashboardUrl: string | null;
    readonly reachable: boolean;
    readonly version: string | null;
    readonly pid: number | null;
    readonly ppid: number | null;
    readonly matchesJob: boolean | null;
  };
  readonly token: string | null;
};

const NO_UNIT: UnitInspection = { present: false, wrapperValid: false, target: null, home: null };
const UNREACHABLE: DesktopConnectResult['instance'] = {
  controlUrl: null,
  dashboardUrl: null,
  reachable: false,
  version: null,
  pid: null,
  ppid: null,
  matchesJob: null,
};

async function readLaunchdUnit(deps: DesktopConnectDeps): Promise<UnitInspection> {
  if (!deps.unitExists()) return NO_UNIT;
  try {
    const { code, stdout } = await deps.run(['plutil', '-convert', 'json', '-o', '-', deps.unitPath]);
    return code === 0 ? inspectUnit(JSON.parse(stdout)) : inspectUnit(undefined);
  } catch {
    return inspectUnit(undefined);
  }
}

async function readLaunchdJob(deps: DesktopConnectDeps): Promise<JobState> {
  try {
    const printed = await deps.run(['launchctl', 'print', launchdJobTarget()]);
    const disabled = await deps.run(['launchctl', 'print-disabled', launchdDomain()]);
    // Fail closed: an unreadable disabled state must never look "enabled", or the app would `enable` a
    // job the user stopped.
    return {
      ...parseJobPrint(printed.code, printed.stdout),
      disabled: disabled.code !== 0 || parseDisabled(disabled.stdout),
    };
  } catch {
    return { loaded: false, disabled: true, pid: null };
  }
}

async function readService(deps: DesktopConnectDeps): Promise<{ unit: UnitInspection; job: JobState }> {
  if (deps.platform === 'win32') return readTask(deps);
  if (deps.platform === 'linux') return { unit: await readSystemdUnit(deps), job: await readSystemdJob(deps) };
  return { unit: await readLaunchdUnit(deps), job: await readLaunchdJob(deps) };
}

async function summaryIdentity(
  deps: DesktopConnectDeps,
  host: string,
  port: string,
  token: string,
): Promise<{ readonly version: string; readonly pid: number; readonly ppid: number | null } | undefined> {
  try {
    const res = await deps.identityGet(host, port, '/dashboard/api/desktop-summary', token);
    if (res === undefined || res.status < 200 || res.status > 299) return undefined;
    const body: unknown = JSON.parse(res.body);
    const server = isPlainObject(body) ? body['server'] : undefined;
    if (!isPlainObject(server) || typeof server['version'] !== 'string' || typeof server['pid'] !== 'number') {
      return undefined;
    }
    return {
      version: server['version'],
      pid: server['pid'],
      ppid: typeof server['ppid'] === 'number' ? server['ppid'] : null,
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether `owner` listens where the probe connects: on `host` itself or on its family's wildcard. The
 * kernel refuses a second user the same port within one family, but not across IPv4 and IPv6, so a
 * listener of this user on `127.0.0.1` proves nothing about `::1`.
 */
export function listensAt(listeners: readonly Socket[], owner: string, host: string, port: string): boolean {
  const ipv6 = host.includes(':');
  const exact = ipv6 ? `[${host}]:${port}` : `${host}:${port}`;
  const family = ipv6 ? 'IPv6' : 'IPv4';
  return listeners.some(
    (l) => l.owner === owner && l.family === family && (l.address === exact || l.address === `*:${port}`),
  );
}

/**
 * Whether a process of this user listens where the probe goes. Another local account could bind the
 * port while the proxy is down and answer `/health`; the token goes only to a listener this user owns.
 * The listing is `lsof` on macOS (an unprivileged one does not even see other users' sockets),
 * `/proc/net/tcp{,6}` uids on Linux, and `netstat` PIDs resolved to their account SID on Windows. A
 * failure counts as not ours.
 */
async function listenerIsOurs(deps: DesktopConnectDeps, host: string, port: string): Promise<boolean> {
  if (!/^\d+$/u.test(port)) return false;
  try {
    return listensAt(await listSockets(deps.platform, Number(port), deps), deps.owner, host, port);
  } catch {
    return false;
  }
}

function readTokenSafely(deps: DesktopConnectDeps, home: string): string | undefined {
  try {
    return deps.readToken(home);
  } catch {
    return undefined;
  }
}

export async function desktopConnect(deps: DesktopConnectDeps): Promise<DesktopConnectResult> {
  const { unit, job } = await readService(deps);
  const owner = unitOwner(unit, deps.env['AIO_PROXY_DESKTOP_EXEC'], deps.targetRunnable, deps.platform);
  // The service's own home, not this process's environment: the app is launched from Finder and
  // does not inherit the shell that installed the service.
  const home = unit.home ?? deps.defaultHome();
  // An unreadable token degrades only the token; the unit/job/instance facts are still worth reporting.
  const token = readTokenSafely(deps, home);
  const address = await resolveControlAddress({}, configPathIn(home));
  const host = localControlHost(address.host);
  if (host === undefined) {
    return {
      protocolVersion: 1,
      bundledVersion: deps.bundledVersion,
      unit: { ...unit, owner },
      job,
      instance: UNREACHABLE,
      token: null,
    };
  }
  const controlUrl = controlBaseUrl(host, address.port);
  const health = await probeHealth(controlUrl, deps.fetch, PROBE_TIMEOUT_MS);
  // The token is reported, and sent for the identity probe, only for a listener this user owns: the
  // app sends it only to an instance discovery reported reachable, so withholding it here covers both.
  const ours = health !== null && (await listenerIsOurs(deps, host, address.port));
  const trustedToken = ours ? token : undefined;
  const identity =
    trustedToken === undefined ? undefined : await summaryIdentity(deps, host, address.port, trustedToken);
  const pid = identity?.pid ?? null;
  const ppid = identity?.ppid ?? null;
  return {
    protocolVersion: 1,
    bundledVersion: deps.bundledVersion,
    unit: { ...unit, owner },
    job,
    instance: {
      controlUrl,
      dashboardUrl: `${controlUrl}/dashboard`,
      reachable: health !== null,
      version: identity?.version ?? health?.version ?? null,
      pid,
      ppid,
      // job.pid is launchd's /bin/sh wrapper or Windows' supervisor, whose child the proxy is (ppid
      // matches), or systemd's MainPID, the proxy itself (pid matches).
      matchesJob: pid === null || job.pid === null ? null : pid === job.pid || ppid === job.pid,
    },
    token: trustedToken ?? null,
  };
}

// Reported when discovery itself throws. `owner: 'unknown'` is deliberate: `null` means "no unit",
// which the app answers with a fresh install, while `unknown` permits no automatic action at all.
const failedDiscovery = (bundledVersion: string): DesktopConnectResult => ({
  protocolVersion: 1,
  bundledVersion,
  unit: { present: true, wrapperValid: false, target: null, home: null, owner: 'unknown' },
  job: { loaded: false, disabled: false, pid: null },
  instance: UNREACHABLE,
  token: null,
});

/** stdout carries exactly this one line, whatever fails; anything human-readable belongs on stderr. */
export async function printDesktopConnect(deps: DesktopConnectDeps, write: (text: string) => void): Promise<void> {
  let result: DesktopConnectResult;
  try {
    result = await desktopConnect(deps);
  } catch {
    result = failedDiscovery(deps.bundledVersion);
  }
  write(`${JSON.stringify(result)}\n`);
}

/** Runs a helper process inside the command's time budget, killing it when the budget runs out. */
export async function runWithin(
  cmd: readonly string[],
  deadline: number,
): Promise<{ readonly code: number; readonly stdout: string }> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('desktop-connect time budget exhausted');
  const proc = Bun.spawn([...cmd], {
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: remaining,
    killSignal: 'SIGKILL',
    windowsHide: true,
    windowsVerbatimArguments: cmd[0] === 'cmd.exe',
  });
  // Windows tools may write UTF-16LE to a pipe.
  const stdout = decodeOutput(await new Response(proc.stdout).bytes());
  return { code: await proc.exited, stdout };
}

// No socket is ever owned by the empty string (every listing drops a row without a uid or SID), so an
// unreadable account withholds the token while discovery still prints its one line.
const NO_OWNER = '';

export const defaultDesktopConnectDeps = async (
  bundledVersion: string,
  spawnDeadline: number = Date.now() + SPAWN_BUDGET_MS,
  ownAccount: () => string = () => currentOwner(process.platform),
): Promise<DesktopConnectDeps> => {
  // Bun's fetch honours HTTP_PROXY even for loopback, which would hand the desktop token's bearer
  // header to the proxy. `*` bypasses every host (a plain `::1` entry does not match [::1]); set on
  // both spellings because the lowercase one wins. This process only probes the local control address.
  process.env['NO_PROXY'] = process.env['no_proxy'] = '*';
  let owner: string;
  try {
    owner = ownAccount();
  } catch {
    owner = NO_OWNER;
  }
  return desktopConnectDeps(bundledVersion, spawnDeadline, owner);
};

const desktopConnectDeps = (bundledVersion: string, spawnDeadline: number, owner: string): DesktopConnectDeps => ({
  platform: process.platform,
  env: process.env,
  bundledVersion,
  unitPath: managedUnitPath(process.platform) ?? '',
  defaultHome: aioHome,
  unitExists: () => {
    const path = managedUnitPath(process.platform);
    return path !== undefined && existsSync(path);
  },
  targetRunnable: isRunnable,
  imagePath: processImagePath,
  creationTime: processCreationTime,
  userSid: processUserSid,
  sidForAccount,
  readToken: (home) => readDesktopToken(home),
  owner,
  // A killed or budget-exhausted helper degrades its fields like any other probe failure.
  run: (cmd) => runWithin(cmd, spawnDeadline),
  readFile: (path) => readFile(path, 'utf8'),
  identityGet: (host, port, path, token) =>
    verifiedGet(
      process.platform,
      {
        run: (cmd) => runWithin(cmd, spawnDeadline),
        readFile: (path) => readFile(path, 'utf8'),
        userSid: processUserSid,
      },
      owner,
      host,
      port,
      path,
      token,
      PROBE_TIMEOUT_MS,
    ),
  fetch,
});
