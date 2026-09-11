import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

export type GrokCompatCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type GrokCompatHttpRecord = {
  readonly method: string;
  readonly path: string;
  readonly origin: string;
  readonly tokenFingerprint?: string;
};

export type GrokCompatFixture = {
  readonly root: string;
  readonly env: Record<string, string>;
  readonly endpoint: string;
  readonly dashboardPassword: string;
  readonly records: readonly GrokCompatHttpRecord[];
  run(argv: readonly string[]): Promise<GrokCompatCommandResult>;
  close(): Promise<void>;
};

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function fingerprint(header: string | null): string | undefined {
  const match = /^Bearer\s+(\S+)/u.exec(header ?? '');
  if (match === null) return undefined;
  return createHash('sha256').update(match[1]!).digest('hex').slice(0, 12);
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
}

async function listenModel(records: GrokCompatHttpRecord[]): Promise<{
  readonly origin: string;
  readonly stop: () => void;
}> {
  let completions = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const tokenFingerprint = fingerprint(request.headers.get('authorization'));
      records.push({
        method: request.method,
        path: url.pathname,
        origin: url.origin,
        ...(tokenFingerprint === undefined ? {} : { tokenFingerprint }),
      });
      if (url.pathname.endsWith('/models') && request.method === 'GET') {
        return json({
          object: 'list',
          data: [{ id: 'compat-grok-model', object: 'model', owned_by: 'aio-proxy-compat' }],
        });
      }
      if (url.pathname.endsWith('/chat/completions') && request.method === 'POST') {
        completions += 1;
        if (completions === 1) {
          return json({
            id: 'compat-1',
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_compat',
                      type: 'function',
                      function: { name: 'exec', arguments: '{"command":"pwd"}' },
                    },
                  ],
                },
              },
            ],
          });
        }
        return json({
          id: 'compat-2',
          object: 'chat.completion',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'compat-ok' } }],
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

async function tryStartProxy(
  cliBinary: string,
  env: Record<string, string>,
  port: number,
): Promise<ReturnType<typeof Bun.spawn> | undefined> {
  const child = Bun.spawn([cliBinary, 'run', '--host', '127.0.0.1', '--port', String(port)], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    env,
  });
  let live = true;
  const exited = child.exited.then(() => {
    live = false;
    return false as const;
  });
  const healthy = (async () => {
    const deadline = Date.now() + 2_000;
    while (live && Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true;
      } catch {}
      await Bun.sleep(50);
    }
    return false;
  })();
  if ((await Promise.race([exited, healthy])) === true) return child;
  try {
    child.kill();
  } catch {}
  await child.exited.catch(() => undefined);
  return undefined;
}

async function spawnArgv(
  argv: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<GrokCompatCommandResult> {
  const command = argv[0];
  if (command === undefined) return { exitCode: 1, stdout: '', stderr: 'missing command' };
  const child = Bun.spawn([command, ...argv.slice(1)], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {}
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
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
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(grokHome, { recursive: true, mode: 0o700 });
  await mkdir(aioHome, { recursive: true, mode: 0o700 });
  await writeFile(join(grokHome, 'config.toml'), HOOKS_OFF, { mode: 0o600 });
  const records: GrokCompatHttpRecord[] = [];
  const model = await listenModel(records);
  const dashboardPassword = crypto.randomUUID();
  const proxyPort = 18_000 + Math.floor(Math.random() * 1000);
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
  const env = {
    ...inheritedEnv(),
    HOME: home,
    GROK_HOME: grokHome,
    AIO_PROXY_HOME: aioHome,
  };
  const proxy = await tryStartProxy(options.cliBinary, env, proxyPort);
  return {
    root,
    env,
    endpoint: `http://127.0.0.1:${proxyPort}`,
    dashboardPassword,
    records,
    run: (argv) => spawnArgv(argv, env, 20_000),
    async close() {
      if (proxy !== undefined) {
        try {
          proxy.kill();
        } catch {}
        await proxy.exited.catch(() => undefined);
      }
      model.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
