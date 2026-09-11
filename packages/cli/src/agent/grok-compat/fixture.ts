import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { grokPaths } from '../grok/files';
import { encodeGrokOwnership, parseGrokOwnership } from '../grok/ownership';
import { readGrokLeaf } from '../grok/toml';
import {
  COMPAT_KILL_GRACE_MS,
  COMPAT_STREAM_SLACK_MS,
  consumeStream,
  escalateKill,
  spawnArgv,
  startArgv,
  type GrokCompatChild,
  type GrokCompatCommandResult,
} from './compat-child';
import { wrapAuthProviderCommand } from './helper-capture';
import { listenLoopbackUpstream, type GrokCompatHttpRecord } from './loopback-upstream';
import type { GrokCompatOptions } from './types';

export { spawnArgv, type GrokCompatChild, type GrokCompatCommandResult } from './compat-child';

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

export type { GrokCompatHttpRecord } from './loopback-upstream';

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

async function startProxy(
  cliBinary: string,
  env: Record<string, string>,
  port: number,
): Promise<{
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly logs: { stdout: string; stderr: string };
  readonly abort: AbortController;
}> {
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
  const abort = new AbortController();
  const child = Bun.spawn([cliBinary, 'run', '--host', '127.0.0.1', '--port', String(port)], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
  const reading = Promise.all([
    consumeStream(child.stdout, stdoutSink, abort.signal),
    consumeStream(child.stderr, stderrSink, abort.signal),
  ]);
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
        return { child, logs, abort };
      }
    } catch {}
    await Bun.sleep(50);
  }
  try {
    child.kill();
  } catch {}
  escalateKill(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
  }, abort);
  await Promise.race([exited.catch(() => undefined), Bun.sleep(COMPAT_KILL_GRACE_MS + COMPAT_STREAM_SLACK_MS)]);
  await reading.catch(() => undefined);
  throw new GrokCompatProxyError(
    `aio-proxy failed to start on 127.0.0.1:${port} stdout=${logs.stdout} stderr=${logs.stderr}`,
    logs,
  );
}

/**
 * Host-only timestamp helper. Writes a temporary Grok auth file under this fixture
 * root. Not natural-expiry evidence. Never reads a user auth.json.
 */
async function syncWrappedAuthOwnership(grokHome: string, configText: string): Promise<void> {
  const ownershipPath = grokPaths(grokHome).ownership;
  let encoded: string;
  try {
    encoded = await Bun.file(ownershipPath).text();
  } catch {
    return;
  }
  const ownership = parseGrokOwnership(encoded);
  const leaves = ownership.leaves.map((leaf) => {
    const isAuthCommand =
      leaf.path.length === 2 &&
      (leaf.path[0] === 'auth' || leaf.path[0] === 'grok_com_config') &&
      leaf.path[1] === 'auth_provider_command';
    return isAuthCommand ? { ...leaf, written: readGrokLeaf(configText, leaf.path) } : leaf;
  });
  if (leaves.every((leaf, index) => leaf === ownership.leaves[index])) return;
  await writeFile(ownershipPath, encodeGrokOwnership({ ...ownership, leaves }), { mode: 0o600 });
}

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
      const wrapped = wrapAuthProviderCommand(text, HELPER_RECORDER, helperCaptureDir);
      await writeFile(configPath, wrapped, { mode: 0o600 });
      await syncWrappedAuthOwnership(grokHome, wrapped);
    },
    run: (argv, timeoutMs = 20_000) =>
      spawnArgv(argv, env, root, timeoutMs, argv[0] === options.grokBinary ? sandboxPrefix : undefined),
    start: (argv) => startArgv(argv, env, root, argv[0] === options.grokBinary ? sandboxPrefix : undefined),
    async close() {
      try {
        proxy.child.kill();
      } catch {}
      escalateKill(() => {
        try {
          proxy.child.kill('SIGKILL');
        } catch {}
      }, proxy.abort);
      await Promise.race([
        proxy.child.exited.catch(() => undefined),
        Bun.sleep(COMPAT_KILL_GRACE_MS + COMPAT_STREAM_SLACK_MS),
      ]);
      model.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
