import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { requireCurrent } from '../grok/lifecycle';
import { parseGrokOwnership } from '../grok/ownership';
import { awaitChild, startArgv } from './compat-child';
import { approveDashboardAuthorization } from './dashboard-approve';
import { createGrokCompatFixture, GrokCompatProxyError, spawnArgv } from './fixture';
import {
  compatScriptShouldFail,
  loopbackRecorderCase,
  redactCompatText,
  runGrokCompatibility,
  sandboxExecCase,
  type GrokCompatOptions,
} from './grok-compat';
import {
  HELPER_STDOUT_KEYS,
  helperStdoutContractCase,
  parseDeviceVerificationUrl,
  wrapAuthProviderCommand,
} from './helper-capture';
import * as grokCompatPublic from './index';
import { listenLoopbackUpstream } from './loopback-upstream';

const SCRIPT = join(import.meta.dir, 'grok-compat.ts');
const SECRET_AT = `aio_agent_at_v1_${'a'.repeat(43)}`;
const SECRET_RT = `aio_agent_rt_v1_${'b'.repeat(43)}`;
const SECRET_USER_CODE = 'WXYZ-USERCODE';
const INSTALLATION_ID = '11111111-1111-4111-8111-111111111111';

async function scratch(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { mode: 0o755 });
  await chmod(path, 0o755);
}

type FakeGrokOptions = {
  readonly version: string;
  readonly loginExit?: number;
  readonly leakSecrets?: boolean;
};

async function fakeGrok(
  root: string,
  options: FakeGrokOptions,
): Promise<{ readonly binary: string; readonly log: string }> {
  const binary = join(root, 'grok');
  const log = join(root, 'calls.log');
  const loginExit = options.loginExit ?? 0;
  const leak = options.leakSecrets === true;
  await writeExecutable(
    binary,
    `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const log = ${JSON.stringify(log)};
const argv = process.argv.slice(2);
appendFileSync(log, \`grok \${argv.join(' ')}\\n\`);
if (argv[0] === '--version') {
  process.stdout.write(${JSON.stringify(`grok ${options.version} (deadbeef)\n`)});
  process.exit(0);
}
if (argv[0] === 'login') {
  ${
    leak
      ? `process.stderr.write(${JSON.stringify(`user_code=${SECRET_USER_CODE}\n`)});
  process.stdout.write(${JSON.stringify(`{"access_token":"${SECRET_AT}","refresh_token":"${SECRET_RT}"}\n`)});`
      : ''
  }
  if (${String(loginExit)} !== 0) process.exit(${String(loginExit)});
  const grokHome = process.env.GROK_HOME;
  if (grokHome === undefined) process.exit(1);
  const toml = readFileSync(join(grokHome, 'config.toml'), 'utf8');
  const match = /auth_provider_command\\s*=\\s*"((?:\\\\.|[^"])*)"/.exec(toml);
  if (match === null || match[1] === undefined) process.exit(1);
  const child = Bun.spawn(['sh', '-c', match[1]], { stdout: 'pipe', stderr: 'pipe', env: process.env, stdin: 'ignore' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exit(code);
}
if (argv[0] === 'models' || argv[0] === '-p') process.exit(0);
process.exit(1);
`,
  );
  return { binary, log };
}

type FakeCliOptions = {
  readonly version?: string;
  readonly serve?: boolean;
  readonly configureExit?: number;
  readonly helperObject?: Record<string, unknown>;
};

async function fakeCli(root: string, options: FakeCliOptions = {}): Promise<string> {
  const binary = join(root, 'aio-proxy');
  const log = join(root, 'calls.log');
  const version = options.version ?? '0.21.0';
  const serve = options.serve !== false;
  const configureExit = options.configureExit ?? 0;
  const helperObject = options.helperObject ?? { access_token: SECRET_AT, expires_in: 900 };
  await writeExecutable(
    binary,
    `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const log = ${JSON.stringify(log)};
const argv = process.argv.slice(2);
appendFileSync(log, \`cli \${argv.join(' ')}\\n\`);
if (argv[0] === '--version') {
  process.stdout.write(${JSON.stringify(`${version}\n`)});
  process.exit(0);
}
if (argv[0] === 'run') {
  if (${serve ? 'false' : 'true'}) process.exit(1);
  const port = Number(argv[argv.indexOf('--port') + 1]);
  Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/health') return new Response('ok');
      if (url.pathname === '/dashboard/api/auth/login') return Response.json({ token: 'compat-session' });
      if (url.pathname === '/dashboard/api/agent-authorizations/resolve') return Response.json({ deviceId: 'compat-device' });
      if (url.pathname.endsWith('/approve')) return Response.json({ status: 'approved' });
      if (url.pathname.startsWith('/v1/')) {
        const auth = request.headers.get('authorization') ?? '';
        if (!auth.startsWith('Bearer aio_agent_at_')) return new Response('unauthorized', { status: 401 });
        return new Response('not found', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  await Bun.sleep(1 << 30);
}
if (argv[0] === 'agent' && argv[1] === 'configure' && argv[2] === 'grok') {
  if (${String(configureExit)} !== 0) process.exit(${String(configureExit)});
  const grokHome = process.env.GROK_HOME;
  if (grokHome === undefined) process.exit(1);
  const self = process.argv[1] ?? '';
  const command = "'" + self.replaceAll("'", "'\\\\''") + "' agent auth grok --installation-id '${INSTALLATION_ID}'";
  const configPath = join(grokHome, 'config.toml');
  let existing = '';
  try { existing = readFileSync(configPath, 'utf8'); } catch {}
  if (!existing.includes('auth_provider_command')) {
    appendFileSync(configPath, '\\n[auth]\\nauth_provider_command = "' + command + '"\\n');
  }
  const privateDir = join(grokHome, 'aio-proxy');
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  let endpoint = 'http://127.0.0.1:9';
  try {
    endpoint = 'http://127.0.0.1:' + String(JSON.parse(readFileSync(join(process.env.AIO_PROXY_HOME ?? '', 'config.jsonc'), 'utf8')).server.port);
  } catch {}
  writeFileSync(
    join(privateDir, 'ownership.json'),
    JSON.stringify({
      format: 1,
      agent: 'grok',
      installationId: '${INSTALLATION_ID}',
      endpoint,
      status: 'active',
      leaves: [{
        path: ['auth', 'auth_provider_command'],
        original: { present: false },
        written: { present: true, value: command, raw: JSON.stringify(command) },
      }],
      createdTables: [['auth']],
    }) + '\\n',
  );
  process.exit(0);
}
if (argv[0] === 'agent' && argv[1] === 'auth' && argv[2] === 'grok') {
  const aio = process.env.AIO_PROXY_HOME;
  let port = 9;
  try {
    port = JSON.parse(readFileSync(join(aio ?? '', 'config.jsonc'), 'utf8')).server.port;
  } catch {}
  process.stderr.write('http://127.0.0.1:' + String(port) + '/dashboard/agents/authorize#code=ABCD-EFGH\\n');
  process.stdout.write(${JSON.stringify(JSON.stringify(helperObject))} + '\\n');
  process.exit(argv.includes('missing') ? 1 : 0);
}
process.exit(1);
`,
  );
  return binary;
}

async function optionsFor(
  root: string,
  grok: FakeGrokOptions,
  cli: FakeCliOptions = {},
): Promise<{ readonly options: GrokCompatOptions; readonly log: string }> {
  const { binary, log } = await fakeGrok(root, grok);
  return {
    options: {
      grokBinary: binary,
      cliBinary: await fakeCli(root, cli),
      expectedVersion: '1.0.24',
      reportPath: join(root, 'report.json'),
    },
    log,
  };
}

function reportHasSecrets(value: unknown): boolean {
  return /access_token|refresh_token|user_code|aio_agent_/u.test(JSON.stringify(value));
}

async function runScript(options: GrokCompatOptions): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = Bun.spawn(
    [
      process.execPath,
      SCRIPT,
      '--grok-bin',
      options.grokBinary,
      '--cli-bin',
      options.cliBinary,
      '--expected-version',
      options.expectedVersion,
      '--report',
      options.reportPath,
    ],
    { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function readLog(log: string): Promise<string> {
  try {
    return await readFile(log, 'utf8');
  } catch {
    return '';
  }
}

test('rejects a fake Grok whose version does not match and never runs login', async () => {
  const root = await scratch('aio-grok-compat-version-');
  try {
    const { options, log } = await optionsFor(root, { version: '9.9.9' });
    await expect(runGrokCompatibility(options)).rejects.toThrow(/9\.9\.9|does not match|version/i);
    expect(await readLog(log)).toContain('--version');
    expect(await readLog(log)).not.toMatch(/\blogin\b/u);
    expect(await Bun.file(options.reportPath).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('marks a nonzero child as a failed case and exits the script nonzero', async () => {
  const root = await scratch('aio-grok-compat-nonzero-');
  try {
    const { options, log } = await optionsFor(root, { version: '1.0.24', loginExit: 7 });
    const report = await runGrokCompatibility(options);
    expect(await readLog(log)).toMatch(/\blogin\b/u);
    const login = report.cases.find((item) => item.name === 'login');
    expect(login?.passed).toBe(false);
    expect(login?.detail).toMatch(/7|nonzero|failed/i);
    const script = await runScript(options);
    expect(script.exitCode).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('redacts base64url tokens that contain hyphens', () => {
  const hyphenAt = `aio_agent_at_v1_-${'a'.repeat(42)}`;
  const hyphenRt = `aio_agent_rt_v1_${'b'.repeat(20)}-${'c'.repeat(22)}`;
  expect(redactCompatText(`stdout=${hyphenAt} stderr=${hyphenRt}`)).toBe('stdout=[redacted] stderr=[redacted]');
});

test('redacts access tokens, refresh tokens, and user_code from the report', async () => {
  const root = await scratch('aio-grok-compat-redact-');
  try {
    const { options } = await optionsFor(root, { version: '1.0.24', loginExit: 1, leakSecrets: true });
    const report = await runGrokCompatibility(options);
    expect(reportHasSecrets(report)).toBe(false);
    expect(report.cases.some((item) => item.name === 'login' && item.passed === false)).toBe(true);
    const written = JSON.parse(await readFile(options.reportPath, 'utf8')) as unknown;
    expect(reportHasSecrets(written)).toBe(false);
    expect(JSON.stringify(written)).not.toContain(SECRET_AT);
    expect(JSON.stringify(written)).not.toContain(SECRET_RT);
    expect(JSON.stringify(written)).not.toContain(SECRET_USER_CODE);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing Grok binary fails instead of claiming pass', async () => {
  const root = await scratch('aio-grok-compat-missing-');
  try {
    const options: GrokCompatOptions = {
      grokBinary: join(root, 'missing-grok'),
      cliBinary: await fakeCli(root),
      expectedVersion: '1.0.24',
      reportPath: join(root, 'report.json'),
    };
    await expect(runGrokCompatibility(options)).rejects.toThrow(/missing|not found|Grok/i);
    const script = await runScript(options);
    expect(script.exitCode).not.toBe(0);
    const reportExists = await Bun.file(options.reportPath).exists();
    if (reportExists) {
      const written = JSON.parse(await readFile(options.reportPath, 'utf8')) as {
        readonly cases?: readonly { readonly passed: boolean }[];
      };
      expect(written.cases?.every((item) => item.passed === true) === true).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sandbox case reports the wrap that actually spawned Grok', () => {
  expect(sandboxExecCase(null, false)).toMatchObject({
    name: 'macos-sandbox-egress',
    passed: false,
    detail: expect.stringMatching(/^not_run:/),
  });
  expect(sandboxExecCase('/usr/bin/sandbox-exec', false)).toMatchObject({
    name: 'macos-sandbox-egress',
    passed: false,
    detail: expect.stringMatching(/^not_run:/),
  });
  expect(sandboxExecCase('/usr/bin/sandbox-exec', true)).toMatchObject({
    name: 'macos-sandbox-egress',
    passed: true,
    detail: expect.stringContaining('/usr/bin/sandbox-exec'),
  });
});

test('loopback recorder fails when models or completions never reach the proxy', () => {
  expect(loopbackRecorderCase([])).toMatchObject({
    name: 'loopback-http-recorder',
    passed: false,
    detail: expect.stringMatching(/GET \/models and two POST \/chat\/completions/),
  });
  expect(loopbackRecorderCase([])).not.toMatchObject({ detail: expect.stringMatching(/^not_run:/) });
  expect(loopbackRecorderCase([{ method: 'GET', path: '/v1/models', origin: 'http://127.0.0.1:9' }])).toMatchObject({
    name: 'loopback-http-recorder',
    passed: false,
    detail: expect.stringMatching(/GET \/models and two POST \/chat\/completions/),
  });
  expect(
    loopbackRecorderCase([
      { method: 'GET', path: '/v1/models', origin: 'http://127.0.0.1:9' },
      { method: 'POST', path: '/v1/chat/completions', origin: 'http://127.0.0.1:9' },
    ]),
  ).toMatchObject({
    name: 'loopback-http-recorder',
    passed: false,
    detail: expect.stringMatching(/two POST \/chat\/completions/),
  });
  expect(
    loopbackRecorderCase([
      { method: 'GET', path: '/v1/models', origin: 'http://127.0.0.1:9' },
      { method: 'POST', path: '/v1/chat/completions', origin: 'http://127.0.0.1:9' },
      { method: 'POST', path: '/v1/chat/completions', origin: 'http://127.0.0.1:9' },
    ]),
  ).toMatchObject({
    name: 'loopback-http-recorder',
    passed: true,
  });
  expect(
    loopbackRecorderCase([
      { method: 'GET', path: '/v1/models', origin: 'http://127.0.0.1:9' },
      { method: 'POST', path: '/v1/chat/completions', origin: 'http://127.0.0.1:9' },
      { method: 'POST', path: '/v1/chat/completions', origin: 'https://api.x.ai' },
    ]),
  ).toMatchObject({
    name: 'loopback-http-recorder',
    passed: false,
    detail: expect.stringContaining('non-loopback origin'),
  });
});

test('index.ts is export-only and does not start the script', async () => {
  const source = await readFile(join(import.meta.dir, 'index.ts'), 'utf8');
  expect(source).not.toContain('import.meta.main');
  expect(typeof grokCompatPublic.runGrokCompatibility).toBe('function');
  expect('createGrokCompatFixture' in grokCompatPublic).toBe(false);
});

test('fixture rejects anonymous model traffic when a static API key is configured', async () => {
  const root = await scratch('aio-grok-compat-apikey-');
  try {
    const { options } = await optionsFor(root, { version: '1.0.24', loginExit: 1 });
    const fixture = await createGrokCompatFixture(options);
    try {
      const config = JSON.parse(await readFile(join(fixture.env['AIO_PROXY_HOME']!, 'config.jsonc'), 'utf8')) as {
        readonly server: { readonly apiKeys?: readonly { readonly key: string }[] };
      };
      expect(config.server.apiKeys?.length).toBe(1);
      expect(config.server.apiKeys?.[0]?.key.startsWith('compat-lock-')).toBe(true);
      expect(config.server.apiKeys?.[0]?.key.startsWith('aio_agent_')).toBe(false);
      const anonymous = await fetch(`${fixture.endpoint}/v1/models`);
      expect(anonymous.status).toBe(401);
      const agent = await fetch(`${fixture.endpoint}/v1/models`, {
        headers: { authorization: `Bearer ${SECRET_AT}` },
      });
      expect(agent.status).not.toBe(401);
    } finally {
      await fixture.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('wrapAuthCommand keeps ownership current after rewriting the helper command', async () => {
  const root = await scratch('aio-grok-compat-wrap-');
  try {
    const { options } = await optionsFor(root, { version: '1.0.24', loginExit: 1 });
    const fixture = await createGrokCompatFixture(options);
    try {
      const configure = await fixture.run([options.cliBinary, 'agent', 'configure', 'grok']);
      expect(configure.exitCode).toBe(0);
      const grokHome = fixture.env['GROK_HOME']!;
      const ownershipPath = join(grokHome, 'aio-proxy', 'ownership.json');
      const before = await readFile(join(grokHome, 'config.toml'), 'utf8');
      requireCurrent(before, parseGrokOwnership(await readFile(ownershipPath, 'utf8')));
      await fixture.wrapAuthCommand();
      const after = await readFile(join(grokHome, 'config.toml'), 'utf8');
      expect(after).toContain('--capture');
      expect(after).not.toBe(before);
      requireCurrent(after, parseGrokOwnership(await readFile(ownershipPath, 'utf8')));
    } finally {
      await fixture.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fixture isolates HOME, GROK_HOME, and AIO_PROXY_HOME and writes hooks-off config', async () => {
  const root = await scratch('aio-grok-compat-fixture-');
  const previousKey = process.env['XAI_API_KEY'];
  const previousGrok = process.env['GROK_XAI_API_BASE_URL'];
  process.env['XAI_API_KEY'] = 'sk-real-spend';
  process.env['GROK_XAI_API_BASE_URL'] = 'https://api.x.ai/v1';
  try {
    const { options } = await optionsFor(root, { version: '1.0.24', loginExit: 1 });
    const fixture = await createGrokCompatFixture(options);
    try {
      expect(fixture.env['HOME']?.startsWith(fixture.root)).toBe(true);
      expect(fixture.env['GROK_HOME']?.startsWith(fixture.root)).toBe(true);
      expect(fixture.env['AIO_PROXY_HOME']?.startsWith(fixture.root)).toBe(true);
      expect(fixture.env['HOME']).not.toBe(process.env['HOME']);
      expect(fixture.env['XAI_API_KEY']).toBeUndefined();
      expect(fixture.env['GROK_XAI_API_BASE_URL']).toBeUndefined();
      expect(Object.keys(fixture.env).every((key) => !key.startsWith('GROK_') || key === 'GROK_HOME')).toBe(true);
      const config = await readFile(join(fixture.env['GROK_HOME']!, 'config.toml'), 'utf8');
      expect(config).toContain('[compat.claude]');
      expect(config).toContain('hooks = false');
      expect(config).toContain('mcps = false');
      expect(config).toContain('agents = false');
      expect(config).toContain('rules = false');
      expect(config).toContain('skills = false');
      expect(config).toContain('[compat.codex]');
      expect(config).toContain('[compat.cursor]');
      const child = await fixture.run([options.cliBinary, '--version']);
      expect(child.exitCode).toBe(0);
      expect(child.stdout).toContain('0.21.0');
    } finally {
      await fixture.close();
    }
  } finally {
    if (previousKey === undefined) delete process.env['XAI_API_KEY'];
    else process.env['XAI_API_KEY'] = previousKey;
    if (previousGrok === undefined) delete process.env['GROK_XAI_API_BASE_URL'];
    else process.env['GROK_XAI_API_BASE_URL'] = previousGrok;
    await rm(root, { recursive: true, force: true });
  }
});

test('proxy start failure fails the fixture instead of continuing', async () => {
  const root = await scratch('aio-grok-compat-proxy-');
  try {
    const { options } = await optionsFor(root, { version: '1.0.24' }, { serve: false });
    await expect(createGrokCompatFixture(options)).rejects.toBeInstanceOf(GrokCompatProxyError);
    await expect(runGrokCompatibility(options)).rejects.toThrow(/failed to start|stdout=|stderr=/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('journey configures before login, approves via Dashboard, and does not treat missing-id auth as stdout contract', async () => {
  const root = await scratch('aio-grok-compat-order-');
  try {
    const source = await readFile(join(import.meta.dir, 'grok-compat.ts'), 'utf8');
    expect(source.indexOf("'agent', 'configure', 'grok'")).toBeGreaterThan(-1);
    expect(source.indexOf("'agent', 'configure', 'grok'")).toBeLessThan(source.indexOf("grokBinary, 'login'"));
    expect(source).toContain('approveDashboardAuthorization');
    expect(source).toContain('signal: loginSignal');
    expect(source).toContain("fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(LOGIN_WAIT_MS) })");
    expect(source.indexOf('AbortSignal.timeout(LOGIN_WAIT_MS)')).toBeLessThan(source.indexOf('awaitChild(loginChild'));
    expect(source).toContain('awaitChild(loginChild');
    expect(source).not.toMatch(/--installation-id['\s,]*missing/u);
    expect(typeof approveDashboardAuthorization).toBe('function');
    expect(HELPER_STDOUT_KEYS).toEqual(['access_token', 'expires_in']);
    const { options, log } = await optionsFor(root, { version: '1.0.24' });
    const report = await runGrokCompatibility(options);
    const calls = await readLog(log);
    const configureAt = calls.indexOf('cli agent configure grok');
    const loginAt = calls.indexOf('grok login');
    expect(configureAt).toBeGreaterThan(-1);
    expect(loginAt).toBeGreaterThan(-1);
    expect(configureAt).toBeLessThan(loginAt);
    expect(calls).not.toMatch(/--installation-id missing/u);
    expect(report.cases.find((item) => item.name === 'configure')?.passed).toBe(true);
    expect(report.cases.find((item) => item.name === 'approve')?.passed).toBe(true);
    expect(report.cases.find((item) => item.name === 'helper-stdout-contract')?.passed).toBe(true);
    expect(report.cases.find((item) => item.name === 'helper-404')?.passed).toBe(true);
    const loopback = report.cases.find((item) => item.name === 'loopback-http-recorder');
    expect(loopback?.passed).toBe(false);
    expect(loopback?.detail.startsWith('not_run:')).toBe(false);
    expect(loopback?.detail).toMatch(/GET \/models and two POST \/chat\/completions/);
    const sandbox = report.cases.find((item) => item.name === 'macos-sandbox-egress');
    expect(sandbox?.passed).toBe(false);
    expect(sandbox?.detail.startsWith('not_run:')).toBe(true);
    expect(compatScriptShouldFail(report)).toBe(true);
    const script = await runScript(options);
    expect(script.exitCode).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed configure does not spawn Grok login or model commands', async () => {
  const root = await scratch('aio-grok-compat-configure-fail-');
  try {
    const { options, log } = await optionsFor(root, { version: '1.0.24' }, { configureExit: 7 });
    const report = await runGrokCompatibility(options);
    const calls = await readLog(log);
    expect(calls).toContain('cli agent configure grok');
    expect(calls).not.toContain('grok login');
    expect(calls).not.toContain('grok models');
    expect(report.cases.find((item) => item.name === 'configure')?.passed).toBe(false);
    expect(report.cases.find((item) => item.name === 'login')?.detail).toMatch(/^not_run:/);
    expect(report.cases.find((item) => item.name === 'models')?.detail).toMatch(/^not_run:/);
    expect(compatScriptShouldFail(report)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('helper recorder persists redacted stdout without the bearer', async () => {
  const root = await scratch('aio-grok-recorder-');
  try {
    const capture = join(root, 'capture');
    const helper = join(root, 'helper.sh');
    await writeExecutable(
      helper,
      `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(JSON.stringify({ access_token: SECRET_AT, expires_in: 900 }))}\n`,
    );
    const recorder = new URL('./helper-recorder.ts', import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, recorder, '--capture', capture, '--', helper], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain(SECRET_AT);
    const captured = await readFile(join(capture, 'stdout'), 'utf8');
    expect(captured).not.toContain(SECRET_AT);
    expect(JSON.parse(captured)).toEqual({ access_token: 'redacted', expires_in: 900 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('version probes return instead of hanging when SIGTERM is ignored', async () => {
  const root = await scratch('aio-grok-compat-version-timeout-');
  const hang = join(root, 'hang-grok');
  try {
    await writeExecutable(
      hang,
      `#!/bin/sh
trap '' TERM
sleep 15 &
wait
`,
    );
    const started = Date.now();
    await expect(
      runGrokCompatibility({
        grokBinary: hang,
        cliBinary: await fakeCli(root),
        expectedVersion: '1.0.24',
        reportPath: join(root, 'report.json'),
      }),
    ).rejects.toThrow(/version failed|timed out/i);
    expect(Date.now() - started).toBeLessThan(8_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loopback completions stream tool-call arguments and terminal text', async () => {
  const records: { readonly method: string; readonly path: string; readonly origin: string }[] = [];
  const server = await listenLoopbackUpstream(records);
  try {
    const first = await fetch(`${server.origin}/v1/chat/completions`, { method: 'POST' });
    expect(first.headers.get('content-type')).toMatch(/text\/event-stream/);
    const firstBody = await first.text();
    expect(firstBody).toContain('chat.completion.chunk');
    expect(firstBody).toContain('"arguments":""');
    expect(firstBody).toContain('\\"command\\":');
    expect(firstBody).toContain('\\"pwd\\"}');
    expect(firstBody).toContain('tool_calls');
    expect(firstBody).toContain('data: [DONE]');
    const second = await fetch(`${server.origin}/v1/chat/completions`, { method: 'POST' });
    expect(second.headers.get('content-type')).toMatch(/text\/event-stream/);
    const secondBody = await second.text();
    expect(secondBody).toContain('"content":"compat"');
    expect(secondBody).toContain('"content":"-ok"');
    expect(secondBody).toContain('data: [DONE]');
  } finally {
    server.stop();
  }
});

test('awaitChild applies the same TERM/KILL deadline to an already-started process', async () => {
  const root = await scratch('aio-grok-compat-await-child-');
  const hang = join(root, 'hang');
  try {
    await writeExecutable(
      hang,
      `#!/bin/sh
trap '' TERM
sleep 15 &
wait
`,
    );
    const started = Date.now();
    const child = startArgv([hang], { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }, root);
    const result = await awaitChild(child, 400);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/timed out/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('compat spawn returns after timeout when SIGTERM is ignored and a descendant holds pipes', async () => {
  const root = await scratch('aio-grok-compat-timeout-');
  const hang = join(root, 'hang');
  try {
    await writeExecutable(
      hang,
      `#!/bin/sh
trap '' TERM
sleep 15 &
wait
`,
    );
    const started = Date.now();
    const result = await spawnArgv([hang], { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }, root, 400);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/timed out/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('helper stdout contract requires exact keys and keeps RT out of stdout', async () => {
  const root = await scratch('aio-grok-compat-helper-keys-');
  try {
    const capture = join(root, 'capture');
    await mkdir(capture, { recursive: true });
    await writeFile(
      join(capture, 'stdout'),
      `${JSON.stringify({ access_token: SECRET_AT, refresh_token: SECRET_RT, expires_in: 9 })}\n`,
    );
    await writeFile(join(capture, 'stderr'), 'http://127.0.0.1:9/dashboard/agents/authorize#code=ABCD-EFGH\n');
    const extra = await helperStdoutContractCase(capture);
    expect(extra.passed).toBe(false);
    await writeFile(join(capture, 'stdout'), `${JSON.stringify({ access_token: SECRET_AT, expires_in: 900 })}\n`);
    const ok = await helperStdoutContractCase(capture);
    expect(ok.passed).toBe(true);
    expect(parseDeviceVerificationUrl('see http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH')).toEqual({
      url: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
    });
    const wrapped = wrapAuthProviderCommand(
      `auth_provider_command = "'/bin/aio-proxy' agent auth grok --installation-id '${INSTALLATION_ID}'"\n`,
      '/recorder.ts',
      '/capture',
      '/bun',
    );
    expect(wrapped).toContain("--capture '/capture' -- ");
    expect(wrapped).toContain("'/bin/aio-proxy' agent auth grok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
