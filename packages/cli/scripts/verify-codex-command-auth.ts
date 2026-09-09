import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type JsonRpcPacket = {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
};

type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

export type CommandAuthProbe = {
  readonly version: string;
  readonly platform: string;
  readonly rawTokenAccepted: boolean;
  readonly incompatibleConfigRejected: boolean;
  readonly refreshAfter401: boolean;
  readonly proactiveRefresh: boolean;
  readonly staticAccountType: 'chatgpt' | null;
  readonly commandAccountType: 'chatgpt' | null;
  readonly authFilesUnchanged: boolean;
};

type RpcSession = {
  readonly call: (method: string, params: unknown) => Promise<unknown>;
  readonly stop: () => Promise<void>;
};

const timeoutMs = 10_000;
const rawToken = 'probe-command-token';
const jsonToken = JSON.stringify({ token: rawToken });
const staticToken = 'probe-static-token';

const authTable = (command: string, args: readonly string[]) => `
[model_providers.proxy.auth]
command = ${JSON.stringify(command)}
args = ${JSON.stringify(args)}
timeout_ms = 5000
refresh_interval_ms = 300000
`;

const rawHelper = String.raw`process.stdout.write("probe-command-token\n");`;

function envFor(root: string, codexHome: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: root,
    CODEX_HOME: codexHome,
    TMPDIR: join(root, 'tmp'),
    ...extra,
  };
}

function sanitizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replaceAll(rawToken, '<token>')
    .replaceAll(jsonToken, '<json>')
    .replaceAll(staticToken, '<static-token>')
    .replaceAll(/Bearer\s+[^\s)]+/g, 'Bearer <redacted>')
    .replaceAll(/\/[^\s:;,)]+/g, '<path>');
}

async function spawn(
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
  input?: string,
  limit = timeoutMs,
): Promise<CommandResult> {
  const child = Bun.spawn(args, {
    cwd,
    env,
    stdin: input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, limit);
  try {
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code: await child.exited, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

async function writeAuthConfig(
  codexHome: string,
  port: number,
  command: string,
  args: readonly string[],
  refreshIntervalMs = 300000,
): Promise<void> {
  const provider = `
[model_providers.proxy]
name = "proxy"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
request_max_retries = 0
${authTable(command, args).replace('refresh_interval_ms = 300000', `refresh_interval_ms = ${refreshIntervalMs}`)}`;
  await Bun.write(
    join(codexHome, 'config.toml'),
    `model = "probe-model"\nmodel_provider = "proxy"\ncli_auth_credentials_store = "file"\n${provider}`,
  );
}

async function writeStaticAuth(codexHome: string): Promise<void> {
  const encoded = (value: Record<string, unknown>): string =>
    `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(value)).toString('base64url')}.synthetic-signature`;
  await Bun.write(
    join(codexHome, 'auth.json'),
    `${JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: encoded({ sub: 'synthetic-account', aud: 'chatgpt.com' }),
        access_token: encoded({
          sub: 'synthetic-account',
          chatgpt_account_id: 'synthetic-account',
          aud: 'https://api.openai.com',
          exp: 4102444800,
        }),
        refresh_token: 'synthetic-refresh-token',
        account_id: 'synthetic-account',
      },
    })}\n`,
  );
}

async function writeStaticConfig(codexHome: string, port: number): Promise<void> {
  await Bun.write(
    join(codexHome, 'config.toml'),
    `model = "probe-model"\nmodel_provider = "proxy"\ncli_auth_credentials_store = "file"\n[model_providers.proxy]\nname = "proxy"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = true\nrequest_max_retries = 0\n`,
  );
}

async function openRpcSession(
  executable: string,
  root: string,
  codexHome: string,
  extraEnv: Record<string, string> = {},
): Promise<RpcSession> {
  const child = Bun.spawn([executable, 'app-server'], {
    cwd: root,
    env: envFor(root, codexHome, extraEnv),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const pending = new Map<number, (packet: JsonRpcPacket) => void>();
  const consume = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const newline = buffer.indexOf('\\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const packet = JSON.parse(line) as JsonRpcPacket;
          if (typeof packet.id === 'number') pending.get(packet.id)?.(packet);
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
  const stderr = new Response(child.stderr).text();
  let nextId = 0;
  const call = (method: string, params: unknown): Promise<unknown> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: timeout`));
      }, timeoutMs);
      pending.set(id, (packet) => {
        clearTimeout(timer);
        pending.delete(id);
        if (packet.error !== undefined) reject(new Error(`${method}: ${packet.error.message ?? 'rejected'}`));
        else resolve(packet.result);
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\\n');
      child.stdin.flush();
    });
  };
  const stop = async (): Promise<void> => {
    child.kill();
    await child.exited;
    await consume;
    await stderr;
  };
  try {
    await call('initialize', {
      clientInfo: { name: 'aio-proxy-command-auth-probe', version: '1' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\\n');
    child.stdin.flush();
    return { call, stop };
  } catch (error) {
    await stop();
    const details = await stderr;
    throw new Error(`${sanitizedError(error)}${details.trim() === '' ? '' : `; stderr=${sanitizedError(details)}`}`);
  }
}

async function waitFor<T>(promise: Promise<T>, limit = timeoutMs): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('probe timeout')), limit)),
  ]);
}

function accountType(value: unknown): 'chatgpt' | null {
  if (typeof value !== 'object' || value === null) return null;
  const account = (value as { account?: unknown }).account;
  if (typeof account !== 'object' || account === null) return null;
  return (account as { type?: unknown }).type === 'chatgpt' ? 'chatgpt' : null;
}

async function commandProbe(
  executable: string,
  root: string,
): Promise<{
  readonly rawTokenAccepted: boolean;
  readonly refreshAfter401: boolean;
  readonly proactiveRefresh: boolean;
  readonly commandAccountType: 'chatgpt' | null;
  readonly errors: readonly string[];
}> {
  const codexHome = join(root, 'command-codex');
  const helperDirectory = join(root, 'helper with spaces');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(helperDirectory, { recursive: true, mode: 0o700 });
  const helper = join(helperDirectory, 'auth helper.js');
  const counter = join(root, 'helper-count');
  const errors: string[] = [];
  const helperSource = `const fs = require('node:fs');
const mode = process.argv[2];
const countFile = process.env.PROBE_COUNT_FILE;
if (countFile) fs.appendFileSync(countFile, mode + '\\n');
if (mode === 'raw') ${rawHelper}
if (mode === 'json') process.stdout.write(${JSON.stringify(jsonToken)} + '\\n');
if (mode === 'empty') process.stdout.write('');
if (mode === 'nonzero') process.exitCode = 7;
if (mode === 'timeout') setTimeout(() => process.stdout.write('late\\n'), 6000);
`;
  await Bun.write(helper, helperSource);
  const command = process.execPath;
  const helperArgs = [helper, 'raw'];
  for (const mode of ['raw', 'json', 'empty', 'nonzero', 'timeout']) {
    const result = await spawn(
      [command, helper, mode],
      envFor(root, codexHome, { PROBE_COUNT_FILE: counter }),
      root,
      undefined,
      5_500,
    );
    if (mode !== 'raw') errors.push(`${mode}: ${result.timedOut ? 'timeout' : `exit=${result.code}`}`);
  }
  const observed: string[] = [];
  let requestNumber = 0;
  let requestResolve: (() => void) | undefined;
  let requestCount = 0;
  const requestArrived = new Promise<void>((resolve) => {
    requestResolve = resolve;
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/v1/responses') return Response.json({ models: [] });
      requestCount += 1;
      observed.push(request.headers.get('authorization') ?? '');
      requestResolve?.();
      if (requestNumber++ === 0) return Response.json({ error: { message: 'synthetic 401' } }, { status: 401 });
      return Response.json({ id: 'probe-response', object: 'response', status: 'completed', output: [] });
    },
  });
  let session: RpcSession | undefined;
  try {
    if (server.port === undefined) throw new Error('local server did not expose a port');
    await writeAuthConfig(codexHome, server.port, command, helperArgs);
    session = await openRpcSession(executable, root, codexHome, { PROBE_COUNT_FILE: counter });
    const commandAccountType = accountType(await session.call('account/read', {}));
    const started = (await session.call('thread/start', {
      cwd: root,
      model: 'probe-model',
      modelProvider: 'proxy',
      sandbox: 'read-only',
    })) as { thread?: { id?: string } };
    const threadId = started.thread?.id;
    if (threadId === undefined) throw new Error('thread/start returned no thread id');
    try {
      await session.call('turn/start', { threadId, input: [{ type: 'text', text: 'command auth probe' }] });
    } catch (error) {
      errors.push(sanitizedError(error));
    }
    await waitFor(requestArrived);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const countBeforeRefresh = (await readFile(counter, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    await writeAuthConfig(codexHome, server.port, command, [helper, 'raw'], 100);
    try {
      await session.call('account/read', {});
    } catch (error) {
      errors.push(sanitizedError(error));
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
    const countAfterRefresh = (await readFile(counter, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    return {
      rawTokenAccepted: observed.some((value) => value === `Bearer ${rawToken}`),
      refreshAfter401:
        requestCount >= 2 && observed[0] === `Bearer ${rawToken}` && observed[1] === `Bearer ${rawToken}`,
      proactiveRefresh: countAfterRefresh > countBeforeRefresh,
      commandAccountType,
      errors,
    };
  } catch (error) {
    errors.push(sanitizedError(error));
    return {
      rawTokenAccepted: false,
      refreshAfter401: false,
      proactiveRefresh: false,
      commandAccountType: null,
      errors,
    };
  } finally {
    if (session !== undefined) await session.stop();
    server.stop(true);
  }
}

async function incompatibleConfigProbe(
  executable: string,
  root: string,
): Promise<{ accepted: boolean; error?: string }> {
  const codexHome = join(root, 'incompatible-codex');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const helper = join(root, 'incompatible-helper.js');
  await Bun.write(helper, rawHelper);
  await Bun.write(
    join(codexHome, 'config.toml'),
    `model = "probe-model"\nmodel_provider = "proxy"\n[model_providers.proxy]\nname = "proxy"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n${authTable(process.execPath, [helper, 'raw'])}`,
  );
  const result = await spawn([executable, 'app-server'], envFor(root, codexHome), root, '');
  return {
    accepted: result.code === 0 && !result.timedOut && !/invalid configuration/i.test(result.stderr),
    error: result.code === 0 ? undefined : sanitizedError(result.stderr),
  };
}

async function staticAccountProbe(
  executable: string,
  root: string,
): Promise<{ type: 'chatgpt' | null; authFilesUnchanged: boolean }> {
  const codexHome = join(root, 'static-codex');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeStaticAuth(codexHome);
  const authBefore = await readFile(join(codexHome, 'auth.json'), 'utf8');
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ models: [] }),
  });
  let session: RpcSession | undefined;
  try {
    if (server.port === undefined) throw new Error('local server did not expose a port');
    await writeStaticConfig(codexHome, server.port);
    session = await openRpcSession(executable, root, codexHome);
    const type = accountType(await session.call('account/read', {}));
    const authAfter = await readFile(join(codexHome, 'auth.json'), 'utf8');
    return { type, authFilesUnchanged: authBefore === authAfter };
  } finally {
    if (session !== undefined) await session.stop();
    server.stop(true);
  }
}

export async function verifyCodexCommandAuth(executable: string): Promise<CommandAuthProbe> {
  if (executable.trim() === '') throw new Error('Codex executable must be non-empty');
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-command-auth-'));
  try {
    await mkdir(join(root, 'tmp'), { recursive: true, mode: 0o700 });
    const version = await spawn([executable, '--version'], envFor(root, root), root);
    const incompatible = await incompatibleConfigProbe(executable, root);
    let command = {
      rawTokenAccepted: false,
      refreshAfter401: false,
      proactiveRefresh: false,
      commandAccountType: null as 'chatgpt' | null,
      errors: [] as readonly string[],
    };
    let staticAccountType: 'chatgpt' | null = null;
    let authFilesUnchanged = true;
    try {
      command = await commandProbe(executable, root);
      const staticResult = await staticAccountProbe(executable, root);
      staticAccountType = staticResult.type;
      authFilesUnchanged = staticResult.authFilesUnchanged;
    } catch (error) {
      command.errors = [...command.errors, sanitizedError(error)];
    }
    for (const error of [...command.errors, ...(incompatible.error === undefined ? [] : [incompatible.error])])
      console.error(`probe error: ${error}`);
    return {
      version: version.stdout.trim() || 'unknown',
      platform: `${process.platform}/${process.arch}`,
      rawTokenAccepted: command.rawTokenAccepted,
      incompatibleConfigRejected: !incompatible.accepted,
      refreshAfter401: command.refreshAfter401,
      proactiveRefresh: command.proactiveRefresh,
      staticAccountType,
      commandAccountType: command.commandAccountType,
      authFilesUnchanged,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const executable = process.argv[2];
  if (process.argv.length !== 3 || executable === undefined || executable.trim() === '') {
    console.error('FAIL: Pass exactly one Codex executable argument');
    process.exitCode = 2;
    return;
  }
  const result = await verifyCodexCommandAuth(executable);
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.rawTokenAccepted, true);
  assert.equal(result.incompatibleConfigRejected, true);
  assert.equal(result.refreshAfter401, true);
  assert.equal(result.proactiveRefresh, true);
  assert.equal(result.staticAccountType, 'chatgpt');
  assert.equal(result.commandAccountType, null);
  assert.equal(result.authFilesUnchanged, true);
}

if (import.meta.main) await main();
