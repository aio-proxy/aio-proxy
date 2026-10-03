import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LAUNCHD_EXEC_WRAPPER } from '../service';
import { renderServiceSpec, renderTaskXml, serviceSpecPath, serviceStatePath } from '../service/schtasks-unit';
import { renderSystemdUnit } from '../service/unit-templates';
import {
  defaultDesktopConnectDeps,
  desktopConnect,
  listensAt,
  printDesktopConnect,
  runWithin,
  type DesktopConnectDeps,
} from './desktop-connect';
import { parseSockets } from './sockets';

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
  readonly disabledCode?: number;
  /** The listener's uid as `lsof` reports it; `null` for none visible. Defaults to this user's. */
  readonly listenerUid?: number | null;
};

// The identity GET goes through the same fake server as fetch, so the recorded requests show its bearer.
const withIdentity = (d: Omit<DesktopConnectDeps, 'identityGet'>): DesktopConnectDeps => ({
  ...d,
  identityGet: async (host, port, path, token) => {
    const authority = host.includes(':') ? `[${host}]` : host;
    const res = await d.fetch(`http://${authority}:${port}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.text() };
  },
});

const deps = (scenario: Scenario, requests: Array<{ url: string; auth: string | null }> = []): DesktopConnectDeps =>
  withIdentity({
    platform: 'darwin',
    env: { AIO_PROXY_DESKTOP_EXEC: link },
    bundledVersion: '0.37.0',
    unitPath: '/tmp/com.aio-proxy.agent.plist',
    defaultHome: () => join(root, 'default-home'),
    unitExists: () => scenario.plist !== undefined,
    imagePath: () => undefined,
    creationTime: () => undefined,
    userSid: () => undefined,
    sidForAccount: () => undefined,
    targetRunnable: () => true,
    readToken: () => scenario.token,
    owner: '501',
    readFile: async () => {
      throw new Error('no /proc on darwin');
    },
    run: async (cmd) => {
      if (cmd[0] === 'plutil') return { code: 0, stdout: JSON.stringify(scenario.plist) };
      if (cmd[0] === '/usr/sbin/lsof') {
        const uid = scenario.listenerUid === undefined ? 501 : scenario.listenerUid;
        // Listening on the probed IPv4 address, at the port in `-iTCP:<port>`.
        const port = cmd[2]?.slice('-iTCP:'.length);
        return uid === null
          ? { code: 1, stdout: '' }
          : { code: 0, stdout: `p4312\nu${uid}\nf12\ntIPv4\nn127.0.0.1:${port}\n` };
      }
      if (scenario.failLaunchctl === true) throw new Error('launchctl missing');
      if (cmd[1] === 'print') return scenario.jobPrint ?? { code: 113, stdout: '' };
      return { code: scenario.disabledCode ?? 0, stdout: scenario.disabled ?? '' };
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

// An unknown disabled state must not read as "enabled": the app would then `enable` a job the user stopped.
test('a launchctl failure degrades the job fields and fails closed on disabled', async () => {
  writeConfig(home(), '127.0.0.1', 9317);
  const result = await desktopConnect(deps({ plist: desktopPlist(), failLaunchctl: true }));
  expect(result.job).toEqual({ loaded: false, disabled: true, pid: null });
});

test('a print-disabled that exits non-zero reports disabled', async () => {
  writeConfig(home(), '127.0.0.1', 9317);
  const result = await desktopConnect(
    deps({ plist: desktopPlist(), jobPrint: { code: 0, stdout: 'pid = 7\n' }, disabledCode: 1 }),
  );
  expect(result.job).toEqual({ loaded: true, disabled: true, pid: 7 });
});

test('an unreadable token degrades only the token', async () => {
  writeConfig(home(), '127.0.0.1', 9317);
  const result = await desktopConnect({
    ...deps({ plist: desktopPlist() }),
    readToken: () => {
      throw new Error('EACCES: permission denied');
    },
  });
  expect(result.token).toBeNull();
  expect(result.unit.owner).toBe('desktop');
  expect(result.instance.reachable).toBe(true);
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
    unitExists: () => {
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

test('an unreadable account still prints one JSON line, and the token is withheld', async () => {
  const saved = { NO_PROXY: process.env['NO_PROXY'], no_proxy: process.env['no_proxy'] };
  let owner: string;
  try {
    owner = (
      await defaultDesktopConnectDeps('0.37.0', Date.now() + 1_000, () => {
        throw new Error('no SID');
      })
    ).owner;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  writeConfig(home(), '127.0.0.1', 9317);
  const lines: string[] = [];
  await printDesktopConnect(
    { ...deps({ plist: desktopPlist(), token: 'T'.repeat(43), summaryPid: 4312 }), owner },
    (text) => void lines.push(text),
  );
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? '')).toMatchObject({ instance: { reachable: true }, token: null });
});

test('a helper that outlives the command budget is killed instead of hanging discovery', async () => {
  const started = performance.now();
  const { code } = await runWithin(['sleep', '5'], Date.now() + 200);
  expect(code).not.toBe(0);
  expect(performance.now() - started).toBeLessThan(2_000);
  await expect(runWithin(['true'], Date.now() - 1)).rejects.toThrow('budget');
});

test('discovery probes never route the desktop token through an environment proxy', async () => {
  const seenByProxy: string[] = [];
  const proxy = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      seenByProxy.push(req.headers.get('authorization') ?? '');
      return new Response('proxied');
    },
  });
  const seenByTarget: string[] = [];
  const target = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      seenByTarget.push(req.headers.get('authorization') ?? '');
      return new Response('direct');
    },
  });
  try {
    const script = `
      import { defaultDesktopConnectDeps } from ${JSON.stringify(join(import.meta.dir, 'desktop-connect.ts'))};
      const deps = await defaultDesktopConnectDeps('0.0.0');
      const res = await deps.fetch(${JSON.stringify(`http://127.0.0.1:${target.port}/`)}, { headers: { authorization: 'Bearer secret' } });
      console.log(await res.text());
    `;
    const child = Bun.spawn([process.execPath, '-e', script], {
      stdout: 'pipe',
      stderr: 'inherit',
      env: {
        ...process.env,
        HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
        http_proxy: `http://127.0.0.1:${proxy.port}`,
        NO_PROXY: '',
        no_proxy: '',
      },
    });
    expect((await new Response(child.stdout).text()).trim()).toBe('direct');
    await child.exited;
    expect(seenByProxy).toEqual([]);
    expect(seenByTarget).toEqual(['Bearer secret']);
  } finally {
    await proxy.stop(true);
    await target.stop(true);
  }
});

// Another local account can bind the port while the proxy is down and answer /health: the token is
// neither sent to that listener nor reported to the app, which sends it only where discovery allows.
test('the token goes only to a listener this user owns', async () => {
  for (const listenerUid of [502, null]) {
    writeConfig(home(), '127.0.0.1', 9317);
    const requests: Array<{ url: string; auth: string | null }> = [];
    const result = await desktopConnect(
      deps({ plist: desktopPlist(), token: 'T'.repeat(43), summaryPid: 4312, listenerUid }, requests),
    );
    expect(result.token).toBeNull();
    expect(result.instance.reachable).toBe(true);
    expect(requests.every((r) => r.auth === null)).toBe(true);
  }
});

test("the listener must be at the probed address or its family's wildcard", () => {
  const listeners = parseSockets(
    'p1\nu501\nf12\ntIPv4\nn127.0.0.1:9317\nf13\ntIPv6\nn*:9418\np2\nu502\nf3\ntIPv6\nn[::1]:9317\n',
  );
  expect(listeners).toEqual([
    { owner: '501', family: 'IPv4', address: '127.0.0.1:9317' },
    { owner: '501', family: 'IPv6', address: '*:9418' },
    { owner: '502', family: 'IPv6', address: '[::1]:9317' },
  ]);
  expect(listensAt(listeners, '501', '127.0.0.1', '9317')).toBe(true);
  // Our IPv4 listener says nothing about ::1, where another user listens on the same port.
  expect(listensAt(listeners, '501', '::1', '9317')).toBe(false);
  expect(listensAt(listeners, '501', '::1', '9418')).toBe(true);
  // An IPv6 wildcard does not vouch for an IPv4 probe.
  expect(listensAt(listeners, '501', '127.0.0.1', '9418')).toBe(false);
});

// /proc/net/tcp row: 127.0.0.1:<port> listening (state 0A), owned by uid 1000.
const procListener = (port: number) =>
  `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n` +
  `   0: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0 100 0 0 10 0\n`;

// systemd's MainPID is the proxy itself (`<exec> run`), so the instance's own pid matches the job.
test('linux: a desktop-owned running unit is identified end to end through MainPID', async () => {
  writeConfig(home(), '127.0.0.1', 19317);
  const linuxLink = '/home/u/.local/share/aio-proxy-desktop/bin/aio-proxy';
  const unitPath = join(root, 'aio-proxy.service');
  writeFileSync(
    unitPath,
    renderSystemdUnit({ exec: linuxLink, configPath: join(home(), 'config.jsonc'), desktopExec: linuxLink }),
  );
  const result = await desktopConnect({
    ...deps({ token: 'T'.repeat(43), summaryPid: 812, summaryPpid: 1 }),
    platform: 'linux',
    env: { AIO_PROXY_DESKTOP_EXEC: linuxLink, XDG_CONFIG_HOME: join(root, 'xdg') },
    owner: '1000',
    unitPath,
    unitExists: () => true,
    readFile: async (path) => {
      if (path === unitPath) return Bun.file(path).text();
      if (path === '/proc/net/tcp') return procListener(19317);
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    run: async (cmd) =>
      cmd[0] === 'systemctl'
        ? { code: 0, stdout: 'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nMainPID=812\n' }
        : { code: 1, stdout: '' },
  });
  expect(result.unit).toEqual({ present: true, wrapperValid: true, target: linuxLink, home: home(), owner: 'desktop' });
  expect(result.job).toEqual({ loaded: true, disabled: false, pid: 812 });
  expect(result.instance).toMatchObject({ reachable: true, pid: 812, matchesJob: true });
  expect(result.token).toBe('T'.repeat(43));
});

// The task runs the supervisor (state-file pid 4310); the proxy (4312) is its child, so its ppid matches.
test('win32: a desktop-owned running task is identified end to end through the supervisor pid', async () => {
  writeConfig(home(), '127.0.0.1', 19317);
  const winLink = 'C:\\Users\\Ada\\AppData\\Local\\aio-proxy-desktop\\bin\\aio-proxy.exe';
  const sid = 'S-1-5-21-1-2-3-1001';
  const localAppData = 'C:\\Users\\Ada\\AppData\\Local';
  const specPath = serviceSpecPath(localAppData);
  const files: Record<string, string> = {
    [specPath]: JSON.stringify(
      renderServiceSpec({ exec: winLink, configPath: join(home(), 'config.jsonc'), desktopExec: winLink }),
    ),
    [serviceStatePath(localAppData)]: JSON.stringify({ pid: 4310, exec: winLink, created: '133000000000000000' }),
  };
  const result = await desktopConnect({
    ...deps({ token: 'T'.repeat(43), summaryPid: 4312, summaryPpid: 4310 }),
    platform: 'win32',
    env: { AIO_PROXY_DESKTOP_EXEC: winLink, LOCALAPPDATA: localAppData },
    owner: sid,
    unitPath: specPath,
    imagePath: (pid) => (pid === 4310 ? winLink : undefined),
    creationTime: (pid) => (pid === 4310 ? '133000000000000000' : undefined),
    userSid: (pid) => (pid === 4312 ? sid : undefined),
    readFile: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    },
    run: async (cmd) => {
      if (cmd[0] === 'cmd.exe') return { code: 0, stdout: renderTaskXml({ sid, exec: winLink, specPath }) };
      if (cmd.join(' ') === 'netstat -ano -p TCP') {
        return { code: 0, stdout: '  TCP    127.0.0.1:19317        0.0.0.0:0              LISTENING       4312\r\n' };
      }
      if (cmd[0] === 'netstat') return { code: 0, stdout: '' };
      return { code: 1, stdout: '' };
    },
  });
  expect(result.unit).toEqual({ present: true, wrapperValid: true, target: winLink, home: home(), owner: 'desktop' });
  expect(result.job).toEqual({ loaded: true, disabled: false, pid: 4310 });
  expect(result.instance).toMatchObject({ reachable: true, pid: 4312, ppid: 4310, matchesJob: true });
  expect(result.token).toBe('T'.repeat(43));
});
