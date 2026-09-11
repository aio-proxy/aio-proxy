import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createGrokCompatFixture } from './fixture';
import { runGrokCompatibility, type GrokCompatOptions } from './grok-compat';
import * as grokCompatPublic from './index';

const SCRIPT = join(import.meta.dir, 'grok-compat.ts');
const SECRET_AT = `aio_agent_at_v1_${'a'.repeat(43)}`;
const SECRET_RT = `aio_agent_rt_v1_${'b'.repeat(43)}`;
const SECRET_USER_CODE = 'WXYZ-USERCODE';

async function scratch(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { mode: 0o755 });
  await chmod(path, 0o755);
}

async function fakeGrok(
  root: string,
  options: { readonly version: string; readonly loginExit?: number; readonly leakSecrets?: boolean },
): Promise<{ readonly binary: string; readonly log: string }> {
  const binary = join(root, 'grok');
  const log = join(root, 'grok-calls.log');
  const loginExit = options.loginExit ?? 0;
  const leak = options.leakSecrets === true;
  await writeExecutable(
    binary,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = "--version" ]; then
  printf 'grok %s (deadbeef)\\n' ${JSON.stringify(options.version)}
  exit 0
fi
if [ "$1" = "login" ]; then
  ${
    leak
      ? `printf 'user_code=${SECRET_USER_CODE}\\n' >&2
  printf '{"access_token":"${SECRET_AT}","refresh_token":"${SECRET_RT}"}\\n'`
      : 'printf "login-started\\n" >&2'
  }
  exit ${String(loginExit)}
fi
exit 1
`,
  );
  return { binary, log };
}

async function fakeCli(root: string, version = '0.21.0'): Promise<string> {
  const binary = join(root, 'aio-proxy');
  await writeExecutable(
    binary,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' ${JSON.stringify(version)}
  exit 0
fi
exit 1
`,
  );
  return binary;
}

async function optionsFor(
  root: string,
  grok: { readonly version: string; readonly loginExit?: number; readonly leakSecrets?: boolean },
): Promise<{ readonly options: GrokCompatOptions; readonly log: string }> {
  const { binary, log } = await fakeGrok(root, grok);
  return {
    options: {
      grokBinary: binary,
      cliBinary: await fakeCli(root),
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

test('index.ts is export-only and does not start the script', async () => {
  const source = await readFile(join(import.meta.dir, 'index.ts'), 'utf8');
  expect(source).not.toContain('import.meta.main');
  expect(typeof grokCompatPublic.runGrokCompatibility).toBe('function');
  expect('createGrokCompatFixture' in grokCompatPublic).toBe(false);
});

test('fixture isolates HOME, GROK_HOME, and AIO_PROXY_HOME and writes hooks-off config', async () => {
  const root = await scratch('aio-grok-compat-fixture-');
  try {
    const { options } = await optionsFor(root, { version: '1.0.24', loginExit: 1 });
    const fixture = await createGrokCompatFixture(options);
    try {
      expect(fixture.env['HOME']?.startsWith(fixture.root)).toBe(true);
      expect(fixture.env['GROK_HOME']?.startsWith(fixture.root)).toBe(true);
      expect(fixture.env['AIO_PROXY_HOME']?.startsWith(fixture.root)).toBe(true);
      expect(fixture.env['HOME']).not.toBe(process.env['HOME']);
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
    await rm(root, { recursive: true, force: true });
  }
});
