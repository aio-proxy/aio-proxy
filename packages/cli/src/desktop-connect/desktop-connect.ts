import { existsSync } from 'node:fs';

import { aioHome, configPathIn, readDesktopToken } from '@aio-proxy/core';
import { isPlainObject } from 'es-toolkit/predicate';

import { controlBaseUrl, localControlHost, probeHealth, resolveControlAddress } from '../control-plane';
import { launchdDomain, launchdJobTarget, managedUnitPath } from '../service';
import { inspectUnit, parseDisabled, parseJobPrint, type UnitInspection, unitOwner } from './launchd-inspect';

const PROBE_TIMEOUT_MS = 2_000;
// The spec bounds the whole command at 10 s. The two HTTP probes take at most 2 s each, so the
// helper processes (plutil, launchctl) share what is left.
const COMMAND_BUDGET_MS = 10_000;
const SPAWN_BUDGET_MS = COMMAND_BUDGET_MS - 2 * PROBE_TIMEOUT_MS;

export type DesktopConnectDeps = {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly bundledVersion: string;
  readonly plistPath: string;
  readonly defaultHome: () => string;
  readonly plistExists: () => boolean;
  readonly readToken: (home: string) => string | undefined;
  /** This process's uid: the listener must belong to it before the token is offered. */
  readonly uid: number;
  readonly run: (cmd: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string }>;
  readonly fetch: typeof fetch;
};

export type DesktopConnectResult = {
  readonly protocolVersion: 1;
  readonly bundledVersion: string;
  readonly unit: UnitInspection & { readonly owner: 'desktop' | 'external' | 'unknown' | null };
  readonly job: { readonly loaded: boolean; readonly disabled: boolean; readonly pid: number | null };
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

async function readUnit(deps: DesktopConnectDeps): Promise<UnitInspection> {
  if (!deps.plistExists()) return NO_UNIT;
  try {
    const { code, stdout } = await deps.run(['plutil', '-convert', 'json', '-o', '-', deps.plistPath]);
    return code === 0 ? inspectUnit(JSON.parse(stdout)) : inspectUnit(undefined);
  } catch {
    return inspectUnit(undefined);
  }
}

async function readJob(deps: DesktopConnectDeps): Promise<DesktopConnectResult['job']> {
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

async function summaryIdentity(
  deps: DesktopConnectDeps,
  controlUrl: string,
  token: string | undefined,
): Promise<{ readonly version: string; readonly pid: number; readonly ppid: number | null } | undefined> {
  if (token === undefined) return undefined;
  try {
    const res = await deps.fetch(`${controlUrl}/dashboard/api/desktop-summary`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
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

/** The uids `lsof -F u` reports for the listeners on a port. */
export function listenerUids(lsofOutput: string): readonly number[] {
  return lsofOutput
    .split('\n')
    .filter((line) => /^u\d+$/u.test(line))
    .map((line) => Number(line.slice(1)));
}

/**
 * Whether a process of this user listens on `port`. Another local account could bind the port while
 * the proxy is down and answer `/health`; the token goes only to a listener this user owns. An
 * unprivileged `lsof` does not even see other users' sockets, and a failure counts as not ours.
 */
async function listenerIsOurs(deps: DesktopConnectDeps, port: number): Promise<boolean> {
  try {
    const { code, stdout } = await deps.run(['/usr/sbin/lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fu']);
    return code === 0 && listenerUids(stdout).includes(deps.uid);
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
  const unit = await readUnit(deps);
  const owner = unitOwner(unit, deps.env['AIO_PROXY_DESKTOP_EXEC']);
  const job = await readJob(deps);
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
  const ours = health !== null && (await listenerIsOurs(deps, address.port));
  const trustedToken = ours ? token : undefined;
  const identity = trustedToken === undefined ? undefined : await summaryIdentity(deps, controlUrl, trustedToken);
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
      // job.pid is the /bin/sh wrapper launchd started; a managed sidecar is its child, so ppid matches.
      matchesJob: pid === null || job.pid === null ? null : pid === job.pid || ppid === job.pid,
    },
    token: trustedToken ?? null,
  };
}

// Reported when discovery itself throws. `owner: 'unknown'` is deliberate: `null` means "no plist",
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
  const proc = Bun.spawn([...cmd], { stdout: 'pipe', stderr: 'ignore', timeout: remaining, killSignal: 'SIGKILL' });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
}

export const defaultDesktopConnectDeps = (
  bundledVersion: string,
  spawnDeadline: number = Date.now() + SPAWN_BUDGET_MS,
): DesktopConnectDeps => {
  // Bun's fetch honours HTTP_PROXY even for loopback, which would hand the desktop token's bearer
  // header to the proxy. `*` bypasses every host (a plain `::1` entry does not match [::1]); set on
  // both spellings because the lowercase one wins. This process only probes the local control address.
  process.env['NO_PROXY'] = process.env['no_proxy'] = '*';
  return desktopConnectDeps(bundledVersion, spawnDeadline);
};

const desktopConnectDeps = (bundledVersion: string, spawnDeadline: number): DesktopConnectDeps => ({
  platform: process.platform,
  env: process.env,
  bundledVersion,
  plistPath: managedUnitPath('darwin') ?? '',
  defaultHome: aioHome,
  plistExists: () => {
    const path = managedUnitPath('darwin');
    return path !== undefined && existsSync(path);
  },
  readToken: (home) => readDesktopToken(home),
  uid: process.getuid?.() ?? -1,
  // A killed or budget-exhausted helper degrades its fields like any other launchctl/plutil failure.
  run: (cmd) => runWithin(cmd, spawnDeadline),
  fetch,
});
