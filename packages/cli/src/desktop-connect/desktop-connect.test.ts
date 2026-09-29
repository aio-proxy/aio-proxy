import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LAUNCHD_EXEC_WRAPPER } from '../service';
import { desktopConnect, printDesktopConnect, runWithin, type DesktopConnectDeps } from './desktop-connect';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aio-desktop-connect-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const link = '/Users/u/Library/Application Support/aio-proxy-desktop/bin/aio-proxy';
const home = () => join(root, 'service-home');

const writeConfig = (dir: string, host: string, port: number) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.jsonc'), JSON.stringify({ server: { host, port }, providers: {} }));
};

type Scenario = {
  readonly plist?: unknown;
  readonly jobPrint?: { readonly code: number; readonly stdout: string };
  readonly disabled?: string;
  readonly token?: string;
  readonly summaryPid?: number;
  readonly summaryPpid?: number;
  readonly failLaunchctl?: boolean;
};

const deps = (scenario: Scenario, requests: Array<{ url: string; auth: string | null }> = []): DesktopConnectDeps => ({
  platform: 'darwin',
  env: { AIO_PROXY_DESKTOP_EXEC: link },
  bundledVersion: '0.37.0',
  plistPath: '/tmp/com.aio-proxy.agent.plist',
  defaultHome: () => join(root, 'default-home'),
  plistExists: () => scenario.plist !== undefined,
  readToken: () => scenario.token,
  run: async (cmd) => {
    if (cmd[0] === 'plutil') return { code: 0, stdout: JSON.stringify(scenario.plist) };
    if (scenario.failLaunchctl === true) throw new Error('launchctl missing');
    if (cmd[1] === 'print') return scenario.jobPrint ?? { code: 113, stdout: '' };
    return { code: 0, stdout: scenario.disabled ?? '' };
  },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, auth: new Headers(init?.headers).get('authorization') });
    if (url.endsWith('/health')) return Response.json({ status: 'ok', version: '0.36.0' });
    if (scenario.summaryPid === undefined) return new Response('not found', { status: 404 });
    return Response.json({
      protocolVersion: 1,
      server: { version: '0.36.0', pid: scenario.summaryPid, ppid: scenario.summaryPpid ?? 1 },
    });
  }) as typeof fetch,
});

const desktopPlist = (target = link) => ({
  ProgramArguments: ['/bin/sh', '-c', LAUNCHD_EXEC_WRAPPER, target],
  EnvironmentVariables: { AIO_PROXY_HOME: home() },
});

// launchd's job pid is the /bin/sh wrapper (4310); the sidecar (4312) is its child, as measured in the spike.
test('a desktop-owned running service is identified end to end through its wrapper pid', async () => {
  writeConfig(home(), '127.0.0.1', 19317);
  const result = await desktopConnect(
    deps({
      plist: desktopPlist(),
      jobPrint: { code: 0, stdout: 'state = running\n\tpid = 4310\n' },
      disabled: '"com.aio-proxy.agent" => enabled',
      token: 'T'.repeat(43),
      summaryPid: 4312,
      summaryPpid: 4310,
    }),
  );
  expect(result).toEqual({
    protocolVersion: 1,
    bundledVersion: '0.37.0',
    unit: { present: true, wrapperValid: true, target: link, home: home(), owner: 'desktop' },
    job: { loaded: true, disabled: false, pid: 4310 },
    instance: {
      controlUrl: 'http://127.0.0.1:19317',
      dashboardUrl: 'http://127.0.0.1:19317/dashboard',
      reachable: true,
      version: '0.36.0',
      pid: 4312,
      ppid: 4310,
      matchesJob: true,
    },
    token: 'T'.repeat(43),
  });
});

test("an external service is probed at the plist's home, and an orphaned sidecar does not match the job", async () => {
  writeConfig(home(), '0.0.0.0', 29317);
  writeConfig(join(root, 'default-home'), '127.0.0.1', 9317);
  const requests: Array<{ url: string; auth: string | null }> = [];
  const result = await desktopConnect(
    deps(
      {
        plist: desktopPlist('/opt/homebrew/bin/aio-proxy'),
        jobPrint: { code: 0, stdout: 'pid = 100\n' },
        token: 'T'.repeat(43),
        // Reparented to launchd: its wrapper died, so it is not the process the job manages.
        summaryPid: 200,
        summaryPpid: 1,
      },
      requests,
    ),
  );
  expect(result.unit.owner).toBe('external');
  expect(result.instance.controlUrl).toBe('http://127.0.0.1:29317');
  expect(result.instance.matchesJob).toBe(false);
  expect(requests.every((request) => request.url.startsWith('http://127.0.0.1:29317/'))).toBe(true);
});

test('a non-loopback bind yields no control URL and no request carries the token', async () => {
  writeConfig(home(), '192.168.1.5', 9317);
  const requests: Array<{ url: string; auth: string | null }> = [];
  const result = await desktopConnect(deps({ plist: desktopPlist(), token: 'T'.repeat(43) }, requests));
  expect(result.instance).toEqual({
    controlUrl: null,
    dashboardUrl: null,
    reachable: false,
    version: null,
    pid: null,
    ppid: null,
    matchesJob: null,
  });
  expect(requests).toEqual([]);
});

test('an older instance without desktop-summary reports its /health version and an unknown pid', async () => {
  writeConfig(home(), '127.0.0.1', 9317);
  const result = await desktopConnect(
    deps({ plist: desktopPlist(), jobPrint: { code: 0, stdout: 'pid = 7\n' }, token: 'T'.repeat(43) }),
  );
  expect(result.instance).toMatchObject({
    reachable: true,
    version: '0.36.0',
    pid: null,
    ppid: null,
    matchesJob: null,
  });
});

test('no plist falls back to the default home and reports no owner', async () => {
  writeConfig(join(root, 'default-home'), '127.0.0.1', 9317);
  const result = await desktopConnect(deps({}));
  expect(result.unit).toEqual({ present: false, wrapperValid: false, target: null, home: null, owner: null });
  expect(result.instance.controlUrl).toBe('http://127.0.0.1:9317');
});

test('a launchctl failure degrades the job fields instead of aborting', async () => {
  writeConfig(home(), '127.0.0.1', 9317);
  const result = await desktopConnect(deps({ plist: desktopPlist(), failLaunchctl: true }));
  expect(result.job).toEqual({ loaded: false, disabled: false, pid: null });
});

test('the command prints exactly one JSON line', async () => {
  writeConfig(home(), '127.0.0.1', 9317);
  let output = '';
  await printDesktopConnect(deps({ plist: desktopPlist(), failLaunchctl: true }), (text) => {
    output += text;
  });
  expect(output.endsWith('\n')).toBe(true);
  expect(output.trimEnd().split('\n')).toHaveLength(1);
  expect(JSON.parse(output).protocolVersion).toBe(1);
});

test('a discovery step that throws still prints one JSON object, and it permits no automation', async () => {
  writeConfig(home(), '127.0.0.1', 9317);
  let output = '';
  const throwing: DesktopConnectDeps = {
    ...deps({ plist: desktopPlist() }),
    readToken: () => {
      throw new Error('EACCES: permission denied');
    },
  };
  await printDesktopConnect(throwing, (text) => {
    output += text;
  });
  expect(output.trimEnd().split('\n')).toHaveLength(1);
  // `owner: null` would mean "no plist" and trigger a fresh install; `unknown` means "never act".
  expect(JSON.parse(output)).toEqual({
    protocolVersion: 1,
    bundledVersion: '0.37.0',
    unit: { present: true, wrapperValid: false, target: null, home: null, owner: 'unknown' },
    job: { loaded: false, disabled: false, pid: null },
    instance: {
      controlUrl: null,
      dashboardUrl: null,
      reachable: false,
      version: null,
      pid: null,
      ppid: null,
      matchesJob: null,
    },
    token: null,
  });
});

test('a helper that outlives the command budget is killed instead of hanging discovery', async () => {
  const started = performance.now();
  const { code } = await runWithin(['sleep', '5'], Date.now() + 200);
  expect(code).not.toBe(0);
  expect(performance.now() - started).toBeLessThan(2_000);
  await expect(runWithin(['true'], Date.now() - 1)).rejects.toThrow('budget');
});
