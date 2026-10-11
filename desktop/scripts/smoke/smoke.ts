import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';

export const freePort = (): number => {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
};

async function waitForHealth(base: string, deadline: number): Promise<{ version?: string }> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return (await response.json()) as { version?: string };
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`${base}/health never answered`);
}

const expectStatus = async (label: string, response: Response, status: number): Promise<Response> => {
  if (response.status !== status) throw new Error(`${label}: HTTP ${response.status}, expected ${status}`);
  return response;
};

/** What the app depends on from a serving instance: the dashboard, its assets, and the token-gated summary. */
export async function httpChecks(base: string, token: string): Promise<void> {
  const html = await (await expectStatus('/dashboard', await fetch(`${base}/dashboard`), 200)).text();
  const asset = /(?:src|href)="(\/dashboard\/static\/[^"]+)"/u.exec(html)?.[1];
  if (asset === undefined) throw new Error('/dashboard HTML references no static asset');
  await expectStatus(asset, await fetch(`${base}${asset}`), 200);
  await expectStatus(
    'desktop-summary',
    await fetch(`${base}/dashboard/api/desktop-summary`, { headers: { authorization: `Bearer ${token}` } }),
    200,
  );
}

/** vmmap lists this region only while JavaScriptCore can JIT; without allow-jit Bun silently runs interpreted. */
export const hasJitRegion = (vmmapOutput: string): boolean => /^JS JIT Generated Code\b/imu.test(vmmapOutput);

async function vmmap(pid: number): Promise<string> {
  const direct = await $`vmmap ${pid}`.nothrow().quiet();
  if (direct.exitCode === 0) return direct.text();
  // A Developer ID hardened process may refuse task_for_pid; CI runners have passwordless sudo, and a
  // developer can cache credentials with `sudo -v` first.
  const elevated = await $`sudo -n vmmap ${pid}`.nothrow().quiet();
  if (elevated.exitCode === 0) return elevated.text();
  throw new Error(
    `vmmap ${pid} failed (${direct.stderr.toString().trim()}); sudo -n vmmap: ${elevated.stderr.toString().trim()}`,
  );
}

/**
 * Runs the bundled sidecar with a throwaway home on a free port and no user tools on PATH, checks
 * what the app depends on, then SIGTERMs it. It never installs a launchd job. With `jit`, the
 * serving sidecar must also show the JIT region (run it against a signed sidecar).
 */
export async function runtimeSmoke(
  app: string,
  version: string,
  options: { readonly jit?: boolean } = {},
): Promise<void> {
  // Bun's fetch honours HTTP_PROXY; the loopback checks below must never go through a proxy.
  process.env['NO_PROXY'] = '*';
  process.env['no_proxy'] = '*';
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-smoke-'));
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const proxy = Bun.spawn([join(app, 'Contents/MacOS/aio-proxy'), 'run', '--port', String(port)], {
    env: { PATH: '/usr/bin:/bin', HOME: home, AIO_PROXY_HOME: home, NO_PROXY: '*', no_proxy: '*' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  try {
    const health = await waitForHealth(base, Date.now() + 30_000);
    if (health.version !== version) throw new Error(`/health reports ${health.version}, bundle is ${version}`);
    await httpChecks(base, (await Bun.file(join(home, 'desktop-token')).text()).trim());
    if (options.jit === true && !hasJitRegion(await vmmap(proxy.pid))) {
      throw new Error('the signed sidecar has no "JS JIT Generated Code" region: is allow-jit missing?');
    }
  } finally {
    proxy.kill('SIGTERM');
    await proxy.exited;
    rmSync(home, { recursive: true, force: true });
  }
}

/** The `__desktop-connect` fields the service smoke asserts on. */
type ConnectReport = {
  readonly unit: { readonly present: boolean; readonly home: string | null; readonly owner: string | null };
  readonly job: { readonly disabled: boolean };
  readonly instance: { readonly reachable: boolean; readonly controlUrl: string | null };
};

export type ServiceSmokeDeps = {
  /** The throwaway `AIO_PROXY_HOME` the service must be installed and discovered at. */
  readonly home: string;
  /**
   * Runs a command to completion with `env` added to this process's environment and returns its stdout;
   * throws on a non-zero exit.
   */
  readonly run: (cmd: readonly string[], env: Readonly<Record<string, string>>) => Promise<string>;
  readonly httpChecks: (base: string) => Promise<void>;
  /** Whether any `aio-proxy` process is still alive. */
  readonly processRemains: () => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
};

const SERVICE_WAIT_MS = 30_000;

const redactToken = (key: string, value: unknown): unknown => (key === 'token' ? '[redacted]' : value);

/**
 * Drives the real service manager (systemd --user or Task Scheduler) through the app's lifecycle and
 * checks, through the same discovery the app runs, that each state holds: a stop and an uninstall must
 * leave the service disabled and down, not respawned by the manager.
 */
export async function serviceSmoke(exec: string, deps: ServiceSmokeDeps): Promise<void> {
  // Passed to every CLI call: the unit records both, and discovery falls back to this home once it is gone.
  const env = { AIO_PROXY_HOME: deps.home, AIO_PROXY_DESKTOP_EXEC: exec };
  const service = (verb: string) => deps.run([exec, 'service', verb], env);
  const waitFor = async <T>(label: string, probe: () => Promise<T>, ok: (value: T) => boolean): Promise<T> => {
    const deadline = deps.now() + SERVICE_WAIT_MS;
    for (;;) {
      const value = await probe();
      if (ok(value)) return value;
      if (deps.now() >= deadline)
        throw new Error(`${label} never held; last saw ${JSON.stringify(value, redactToken)}`);
      await deps.sleep(500);
    }
  };
  const connect = async (): Promise<ConnectReport> => {
    const report = JSON.parse(await deps.run([exec, '__desktop-connect'], env)) as ConnectReport;
    // Polling cannot fix a unit installed somewhere else: every later check would describe the wrong service.
    if (report.unit.present && (report.unit.home !== deps.home || report.unit.owner !== 'desktop')) {
      throw new Error(
        `the unit is not the smoke's desktop-owned service at ${deps.home}: ${JSON.stringify(report.unit)}`,
      );
    }
    return report;
  };
  const expectState = (label: string, disabled: boolean, reachable: boolean) =>
    waitFor(label, connect, (c) => c.job.disabled === disabled && c.instance.reachable === reachable);

  await service('install');
  await service('start');
  const up = await expectState('started and reachable', false, true);
  if (up.instance.controlUrl === null) throw new Error('a reachable instance reported no control URL');
  await deps.httpChecks(up.instance.controlUrl);
  await service('stop');
  await expectState('stopped and disabled', true, false);
  await service('start');
  await expectState('restarted after a stop', false, true);
  await service('restart');
  await expectState('reachable after restart', false, true);
  await service('uninstall');
  await waitFor('no aio-proxy process after uninstall', deps.processRemains, (remains) => !remains);
  await expectState('uninstalled and disabled', true, false);
}
