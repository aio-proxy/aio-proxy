import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createContext,
  envFor,
  openRpcSession,
  spawn,
  timeoutMs,
  type ProbeContext,
  type RpcSession,
} from './codex-command-auth-runtime';

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

const rawToken = 'probe-command-token';
const refreshedToken = 'probe-command-token-refreshed';
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

function sanitizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replaceAll(rawToken, '<token>')
    .replaceAll(jsonToken, '<json>')
    .replaceAll(staticToken, '<static-token>')
    .replaceAll(/Bearer\s+[^\s)]+/g, 'Bearer <redacted>')
    .replaceAll(/\/[^\s:;,)]+/g, '<path>');
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

function accountType(value: unknown): 'chatgpt' | null {
  if (typeof value !== 'object' || value === null) return null;
  const account = (value as { account?: unknown }).account;
  if (typeof account !== 'object' || account === null) return null;
  return (account as { type?: unknown }).type === 'chatgpt' ? 'chatgpt' : null;
}

function authorizationMatches(request: Request, token: string): boolean {
  const value = request.headers.get('authorization');
  return value !== null && value.startsWith('Bearer ') && value.slice('Bearer '.length) === token;
}

async function helperCount(path: string): Promise<number> {
  return (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
}

async function commandProbe(
  context: ProbeContext,
  executable: string,
  root: string,
  addDiagnostic: (message: string) => void,
): Promise<{
  readonly complete: boolean;
  readonly rawTokenAccepted: boolean;
  readonly refreshAfter401: boolean;
  readonly commandAccountType: 'chatgpt' | null;
}> {
  const codexHome = join(root, 'command-codex');
  const helperDirectory = join(root, 'helper with spaces');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(helperDirectory, { recursive: true, mode: 0o700 });
  const helper = join(helperDirectory, 'auth helper.js');
  const counter = join(root, 'helper-count');
  const marker = join(root, 'refresh-marker');
  const helperSource = `const fs = require('node:fs');
const mode = process.argv[2];
const countFile = process.env.PROBE_COUNT_FILE;
const markerFile = process.env.PROBE_REFRESH_MARKER;
const count = countFile && fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8').split('\\n').filter(Boolean).length : 0;
if (countFile) fs.appendFileSync(countFile, mode + '\\n');
if (mode === 'sequence') process.stdout.write(markerFile && fs.existsSync(markerFile) && count > Number(fs.readFileSync(markerFile, 'utf8')) ? '${refreshedToken}\\n' : '${rawToken}\\n');
if (mode === 'raw') ${rawHelper}
if (mode === 'json') process.stdout.write(${JSON.stringify(jsonToken)} + '\\n');
if (mode === 'empty') process.stdout.write('');
if (mode === 'nonzero') process.exitCode = 7;
if (mode === 'timeout') setTimeout(() => process.stdout.write('late\\n'), 6000);
`;
  await Bun.write(helper, helperSource);
  const command = process.execPath;
  let requestNumber = 0;
  let requestResolve: (() => void) | undefined;
  let requestCount = 0;
  let firstRequestUsedRaw = false;
  let secondRequestUsedRefreshed = false;
  let allObservedRequestsUsedExpectedBearer = true;
  const requestArrived = new Promise<void>((resolve) => {
    requestResolve = resolve;
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/v1/responses') return Response.json({ models: [] });
      requestCount += 1;
      const requestIndex = requestNumber++;
      firstRequestUsedRaw ||= requestIndex === 0 && authorizationMatches(request, rawToken);
      secondRequestUsedRefreshed ||= requestIndex === 1 && authorizationMatches(request, refreshedToken);
      allObservedRequestsUsedExpectedBearer &&=
        requestIndex === 0
          ? authorizationMatches(request, rawToken)
          : requestIndex === 1 && authorizationMatches(request, refreshedToken);
      if (requestIndex === 0) return Response.json({ error: { message: 'synthetic 401' } }, { status: 401 });
      requestResolve?.();
      return Response.json({ id: 'probe-response', object: 'response', status: 'completed', output: [] });
    },
  });
  let session: RpcSession | undefined;
  try {
    if (server.port === undefined) throw new Error('local server did not expose a port');
    await writeAuthConfig(codexHome, server.port, command, [helper, 'sequence']);
    session = await openRpcSession(context, executable, root, codexHome, sanitizedError, {
      PROBE_COUNT_FILE: counter,
      PROBE_REFRESH_MARKER: marker,
    });
    const commandAccountType = accountType(await session.call('account/read', {}));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const baseline = (await readFile(counter, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    await Bun.write(marker, String(baseline));
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
      addDiagnostic(sanitizedError(error));
    }
    const secondRequest = await Promise.race([
      requestArrived.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), Math.min(timeoutMs, context.remaining()))),
    ]);
    const helperInvocations = (await readFile(counter, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    addDiagnostic(
      `command: requests=${requestCount}; firstExpected=${firstRequestUsedRaw}; secondExpected=${secondRequestUsedRefreshed}; helperInvocations=${helperInvocations - baseline}`,
    );
    return {
      complete: secondRequest,
      rawTokenAccepted: firstRequestUsedRaw && allObservedRequestsUsedExpectedBearer,
      refreshAfter401:
        requestCount >= 2 && firstRequestUsedRaw && secondRequestUsedRefreshed && helperInvocations >= baseline + 2,
      commandAccountType,
    };
  } catch (error) {
    addDiagnostic(sanitizedError(error));
    return {
      complete: false,
      rawTokenAccepted: false,
      refreshAfter401: false,
      commandAccountType: null,
    };
  } finally {
    if (session !== undefined) await session.stop();
    server.stop(true);
  }
}

async function malformedCommandProbe(
  context: ProbeContext,
  executable: string,
  root: string,
  addDiagnostic: (message: string) => void,
): Promise<boolean> {
  const helper = join(root, 'helper with spaces', 'auth helper.js');
  let complete = true;
  for (const mode of ['json', 'empty', 'nonzero', 'timeout']) {
    const codexHome = join(root, `mode-${mode}`);
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const count = join(root, `mode-${mode}-count`);
    let requestCount = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname !== '/v1/responses') return Response.json({ models: [] });
        requestCount += 1;
        return Response.json({ error: { message: 'synthetic helper mode' } }, { status: 401 });
      },
    });
    let session: RpcSession | undefined;
    try {
      if (server.port === undefined) throw new Error(`${mode}: local server unavailable`);
      await writeAuthConfig(codexHome, server.port, process.execPath, [helper, mode]);
      session = await openRpcSession(context, executable, root, codexHome, sanitizedError, {
        PROBE_COUNT_FILE: count,
      });
      const started = (await session.call('thread/start', {
        cwd: root,
        model: 'probe-model',
        modelProvider: 'proxy',
        sandbox: 'read-only',
      })) as { thread?: { id?: string } };
      if (started.thread?.id === undefined) throw new Error(`${mode}: thread/start returned no id`);
      try {
        await session.call('turn/start', {
          threadId: started.thread.id,
          input: [{ type: 'text', text: `helper ${mode}` }],
        });
      } catch (error) {
        addDiagnostic(`${mode}: ${sanitizedError(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      const invocations = await helperCount(count);
      addDiagnostic(`${mode}: requests=${requestCount}; invocations=${invocations}`);
      if (invocations === 0) complete = false;
    } catch (error) {
      const invocations = await helperCount(count);
      addDiagnostic(`${mode}: ${sanitizedError(error)} invocations=${invocations}`);
      if (invocations === 0) complete = false;
    } finally {
      if (session !== undefined) await session.stop();
      server.stop(true);
    }
  }
  return complete;
}

async function proactiveRefreshProbe(
  context: ProbeContext,
  executable: string,
  root: string,
  addDiagnostic: (message: string) => void,
): Promise<{ readonly complete: boolean; readonly refreshed: boolean }> {
  const codexHome = join(root, 'proactive-codex');
  const helper = join(root, 'helper with spaces', 'auth helper.js');
  const counter = join(root, 'proactive-count');
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ models: [] }) });
  let session: RpcSession | undefined;
  try {
    if (server.port === undefined) throw new Error('proactive: local server unavailable');
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await writeAuthConfig(codexHome, server.port, process.execPath, [helper, 'sequence'], 100);
    session = await openRpcSession(context, executable, root, codexHome, sanitizedError, {
      PROBE_COUNT_FILE: counter,
      PROBE_REFRESH_MARKER: join(root, 'missing-refresh-marker'),
    });
    await session.call('account/read', {});
    const baseline = (await readFile(counter, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    await new Promise((resolve) => setTimeout(resolve, 350));
    const after = (await readFile(counter, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    return { complete: true, refreshed: after > baseline };
  } catch (error) {
    addDiagnostic(`proactive: ${sanitizedError(error)}`);
    return { complete: false, refreshed: false };
  } finally {
    if (session !== undefined) await session.stop();
    server.stop(true);
  }
}

async function incompatibleConfigProbe(
  context: ProbeContext,
  executable: string,
  root: string,
  addDiagnostic: (message: string) => void,
): Promise<{ rejected: boolean }> {
  const codexHome = join(root, 'incompatible-codex');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const helper = join(root, 'incompatible-helper.js');
  await Bun.write(helper, rawHelper);
  await Bun.write(
    join(codexHome, 'config.toml'),
    `model = "probe-model"\nmodel_provider = "proxy"\n[model_providers.proxy]\nname = "proxy"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n${authTable(process.execPath, [helper, 'raw'])}`,
  );
  const result = await spawn(context, [executable, 'app-server'], envFor(root, codexHome), root, '');
  const error = sanitizedError(result.stderr);
  const configRejected =
    !result.timedOut &&
    /invalid configuration|unknown (configuration )?field|unexpected key|expected newline/i.test(error);
  addDiagnostic(
    `incompatible: ${result.timedOut ? 'timeout' : configRejected ? 'rejected' : result.code === 0 ? 'loaded' : 'failed'}`,
  );
  return { rejected: configRejected };
}

async function staticAccountProbe(
  context: ProbeContext,
  executable: string,
  root: string,
  addDiagnostic: (message: string) => void,
): Promise<{ complete: boolean; type: 'chatgpt' | null; authFilesUnchanged: boolean }> {
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
    session = await openRpcSession(context, executable, root, codexHome, sanitizedError);
    const type = accountType(await session.call('account/read', {}));
    const authAfter = await readFile(join(codexHome, 'auth.json'), 'utf8');
    return { complete: true, type, authFilesUnchanged: authBefore === authAfter };
  } catch (error) {
    addDiagnostic(`static: ${sanitizedError(error)}`);
    return { complete: false, type: null, authFilesUnchanged: false };
  } finally {
    if (session !== undefined) await session.stop();
    server.stop(true);
  }
}

export async function verifyCodexCommandAuth(executable: string): Promise<CommandAuthProbe> {
  if (executable.trim() === '') throw new Error('Codex executable must be non-empty');
  const context = createContext();
  const errors: string[] = [];
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-command-auth-'));
  const deadlineTimer = setTimeout(() => void context.stopAll(), context.remaining());
  let result: CommandAuthProbe = {
    version: 'unknown',
    platform: `${process.platform}/${process.arch}`,
    rawTokenAccepted: false,
    incompatibleConfigRejected: false,
    refreshAfter401: false,
    proactiveRefresh: false,
    staticAccountType: null,
    commandAccountType: null,
    authFilesUnchanged: false,
  };
  try {
    await mkdir(join(root, 'tmp'), { recursive: true, mode: 0o700 });
    const version = await spawn(context, [executable, '--version'], envFor(root, root), root);
    const versionText = version.stdout.trim() || 'unknown';
    const incompatible = await incompatibleConfigProbe(context, executable, root, (message) => errors.push(message));
    const command = await commandProbe(context, executable, root, (message) => errors.push(message));
    const malformedComplete = await malformedCommandProbe(context, executable, root, (message) => errors.push(message));
    const proactive = await proactiveRefreshProbe(context, executable, root, (message) => errors.push(message));
    const staticResult = await staticAccountProbe(context, executable, root, (message) => errors.push(message));
    result = {
      version: versionText,
      platform: `${process.platform}/${process.arch}`,
      rawTokenAccepted: command.rawTokenAccepted,
      incompatibleConfigRejected: incompatible.rejected,
      refreshAfter401: command.refreshAfter401,
      proactiveRefresh: proactive.refreshed,
      staticAccountType: staticResult.type,
      commandAccountType: command.commandAccountType,
      authFilesUnchanged:
        command.complete &&
        malformedComplete &&
        proactive.complete &&
        staticResult.complete &&
        staticResult.authFilesUnchanged,
    };
  } catch (error) {
    errors.push(sanitizedError(error));
  } finally {
    clearTimeout(deadlineTimer);
    await context.stopAll();
    await rm(root, { recursive: true, force: true });
  }
  for (const error of errors) console.error(`probe error: ${error}`);
  return result;
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
