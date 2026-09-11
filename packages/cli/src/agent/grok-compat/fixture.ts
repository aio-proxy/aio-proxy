import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { wrapAuthProviderCommand } from './helper-capture';
import { listenLoopbackUpstream, type GrokCompatHttpRecord } from './loopback-upstream';
import type { GrokCompatOptions } from './types';

const HOOKS_OFF = `[compat.claude]
hooks = false
mcps = false
agents = false
rules = false
skills = false
[compat.codex]
hooks = false
[compat.cursor]
hooks = false
`;

const ENV_ALLOWLIST = [
  'PATH',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'TMPDIR',
  'TMP',
  'TEMP',
] as const;

export const HELPER_RECORDER = new URL('./helper-recorder.ts', import.meta.url).pathname;

export type GrokCompatCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type { GrokCompatHttpRecord } from './loopback-upstream';

export type GrokCompatChild = {
  readonly result: Promise<GrokCompatCommandResult>;
  stdout(): string;
  stderr(): string;
  finished(): boolean;
  kill(): void;
};

export class GrokCompatProxyError extends Error {
  constructor(
    message: string,
    readonly proxyLogs: { readonly stdout: string; readonly stderr: string },
  ) {
    super(message);
    this.name = 'GrokCompatProxyError';
  }
}

export type GrokCompatFixture = {
  readonly root: string;
  readonly env: Record<string, string>;
  readonly endpoint: string;
  readonly dashboardPassword: string;
  readonly helperCaptureDir: string;
  readonly records: readonly GrokCompatHttpRecord[];
  readonly proxyLogs: { readonly stdout: string; readonly stderr: string };
  readonly sandboxExec: string | null;
  wrapAuthCommand(): Promise<void>;
  run(argv: readonly string[], timeoutMs?: number): Promise<GrokCompatCommandResult>;
  start(argv: readonly string[]): GrokCompatChild;
  close(): Promise<void>;
};

function allowlistedEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  return { ...env, ...overrides };
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('loopback port unavailable'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(port);
      });
    });
  });
}

async function consumeStream(stream: ReadableStream<Uint8Array> | undefined, sink: { text: string }): Promise<void> {
  if (stream === undefined) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) sink.text += decoder.decode(value, { stream: true });
  }
  sink.text += decoder.decode();
}

async function startProxy(
  cliBinary: string,
  env: Record<string, string>,
  port: number,
): Promise<{ readonly child: ReturnType<typeof Bun.spawn>; readonly logs: { stdout: string; stderr: string } }> {
  const stdoutSink = { text: '' };
  const stderrSink = { text: '' };
  const logs = {
    get stdout() {
      return stdoutSink.text;
    },
    get stderr() {
      return stderrSink.text;
    },
  };
  const child = Bun.spawn([cliBinary, 'run', '--host', '127.0.0.1', '--port', String(port)], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
  const reading = Promise.all([consumeStream(child.stdout, stdoutSink), consumeStream(child.stderr, stderrSink)]);
  let live = true;
  const exited = child.exited.then((code) => {
    live = false;
    return code;
  });
  const deadline = Date.now() + 15_000;
  while (live && Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) {
        void reading;
        return { child, logs };
      }
    } catch {}
    await Bun.sleep(50);
  }
  try {
    child.kill();
  } catch {}
  await exited.catch(() => undefined);
  await reading.catch(() => undefined);
  throw new GrokCompatProxyError(
    `aio-proxy failed to start on 127.0.0.1:${port} stdout=${logs.stdout} stderr=${logs.stderr}`,
    logs,
  );
}

function startArgv(
  argv: readonly string[],
  env: Record<string, string>,
  cwd: string,
  prefix?: readonly string[],
): GrokCompatChild {
  const command = argv[0];
  const stdoutSink = { text: '' };
  const stderrSink = { text: '' };
  if (command === undefined) {
    return {
      result: Promise.resolve({ exitCode: 1, stdout: '', stderr: 'missing command' }),
      stdout: () => '',
      stderr: () => 'missing command',
      finished: () => true,
      kill() {},
    };
  }
  const launched = prefix === undefined ? [command, ...argv.slice(1)] : [...prefix, command, ...argv.slice(1)];
  const child = Bun.spawn([launched[0]!, ...launched.slice(1)], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
  let done = false;
  const result = Promise.all([
    consumeStream(child.stdout, stdoutSink),
    consumeStream(child.stderr, stderrSink),
    child.exited,
  ]).then(([, , exitCode]) => ({ exitCode, stdout: stdoutSink.text, stderr: stderrSink.text }));
  void result.finally(() => {
    done = true;
  });
  return {
    result,
    stdout: () => stdoutSink.text,
    stderr: () => stderrSink.text,
    finished: () => done,
    kill() {
      try {
        child.kill();
      } catch {}
    },
  };
}

async function spawnArgv(
  argv: readonly string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
  prefix?: readonly string[],
): Promise<GrokCompatCommandResult> {
  const child = startArgv(argv, env, cwd, prefix);
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    return await child.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Host-only timestamp helper. Writes a temporary Grok auth file under this fixture
 * root. Not natural-expiry evidence. Never reads a user auth.json.
 */
export async function writeFixtureGrokAuth(root: string, text: string): Promise<string> {
  const authPath = resolve(root, 'auth.json');
  const prefix = resolve(root);
  if (authPath !== prefix && !authPath.startsWith(`${prefix}/`)) {
    throw new Error('host-only auth must stay inside the fixture root');
  }
  await writeFile(authPath, text, { mode: 0o600 });
  return authPath;
}

export async function createGrokCompatFixture(options: GrokCompatOptions): Promise<GrokCompatFixture> {
  const root = await mkdtemp(join(tmpdir(), 'aio-grok-compat-'));
  const home = join(root, 'home');
  const grokHome = join(root, 'grok');
  const aioHome = join(root, 'aio');
  const tmp = join(root, 'tmp');
  const safeBin = join(root, 'safe-bin');
  const helperCaptureDir = join(root, 'helper-capture');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(grokHome, { recursive: true, mode: 0o700 });
  await mkdir(aioHome, { recursive: true, mode: 0o700 });
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  await mkdir(safeBin, { recursive: true, mode: 0o700 });
  await mkdir(helperCaptureDir, { recursive: true, mode: 0o700 });
  await writeFile(join(grokHome, 'config.toml'), HOOKS_OFF, { mode: 0o600 });
  await writeFile(join(safeBin, 'pwd'), `#!/bin/sh\ncd ${JSON.stringify(root)} || exit 1\nexec /bin/pwd\n`, {
    mode: 0o755,
  });
  const records: GrokCompatHttpRecord[] = [];
  const model = await listenLoopbackUpstream(records);
  const dashboardPassword = crypto.randomUUID();
  const proxyPort = await freeLoopbackPort();
  await writeFile(
    join(aioHome, 'config.jsonc'),
    `${JSON.stringify(
      {
        server: { host: '127.0.0.1', port: proxyPort, password: dashboardPassword },
        providers: {
          loopback: {
            kind: 'api',
            protocol: 'openai-compatible',
            baseURL: `${model.origin}/v1`,
            apiKey: 'compat-loopback',
            models: ['compat-grok-model'],
          },
        },
      },
      undefined,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const parentPath = process.env['PATH'] ?? '/usr/bin:/bin';
  const env = allowlistedEnv({
    HOME: home,
    GROK_HOME: grokHome,
    AIO_PROXY_HOME: aioHome,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    PATH: `${safeBin}:${parentPath}`,
  });
  const proxy = await startProxy(options.cliBinary, env, proxyPort);
  const sandbox = Bun.which('sandbox-exec');
  const sandboxPrefix =
    sandbox === null
      ? undefined
      : ([
          sandbox,
          '-p',
          `(version 1)(allow default)(deny network*)(allow network* (remote ip "localhost:*") (remote ip "127.0.0.1:*") (local ip "localhost:*") (local ip "127.0.0.1:*"))`,
        ] as const);
  return {
    root,
    env,
    endpoint: `http://127.0.0.1:${proxyPort}`,
    dashboardPassword,
    helperCaptureDir,
    records,
    proxyLogs: proxy.logs,
    sandboxExec: sandbox,
    async wrapAuthCommand() {
      const configPath = join(grokHome, 'config.toml');
      const text = await Bun.file(configPath).text();
      await writeFile(configPath, wrapAuthProviderCommand(text, HELPER_RECORDER, helperCaptureDir), { mode: 0o600 });
    },
    run: (argv, timeoutMs = 20_000) =>
      spawnArgv(argv, env, root, timeoutMs, argv[0] === options.grokBinary ? sandboxPrefix : undefined),
    start: (argv) => startArgv(argv, env, root, argv[0] === options.grokBinary ? sandboxPrefix : undefined),
    async close() {
      try {
        proxy.child.kill();
      } catch {}
      await proxy.child.exited.catch(() => undefined);
      model.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
