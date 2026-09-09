import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inspectCodexStorage } from './codex-storage';

type JsonRpcPacket = {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
};

type ProbeResult = {
  readonly name: string;
  readonly status: 'PASS' | 'FAIL' | 'BLOCKED';
  readonly detail: string;
};

type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};
const executable = process.argv[2];
if (process.argv.length !== 3 || executable === undefined || executable.trim() === '') {
  console.error('FAIL: Pass exactly one Codex executable argument');
  process.exit(2);
}

const timeoutMs = 10_000;
const expectedLoginToken = 'synthetic-login-token';
async function command(args: readonly string[], env: Record<string, string>, cwd: string): Promise<CommandResult> {
  const child = Bun.spawn([executable!, ...args], {
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code: await child.exited, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

function isolatedEnv(root: string, codexHome: string): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: root,
    CODEX_HOME: codexHome,
    TMPDIR: join(root, 'tmp'),
  };
}
async function writeConfig(codexHome: string, port: number, proxyKey: string): Promise<void> {
  const config = Bun.TOML.stringify({
    model: 'contract-model',
    model_provider: 'contract-proxy',
    cli_auth_credentials_store: 'file',
    model_providers: {
      'contract-proxy': {
        name: 'contract-proxy',
        base_url: `http://127.0.0.1:${port}/v1`,
        wire_api: 'responses',
        requires_openai_auth: true,
        experimental_bearer_token: proxyKey,
        request_max_retries: 0,
      },
    },
  });
  if (config === undefined) throw new Error('Failed to serialize Codex config');
  await Bun.write(join(codexHome, 'config.toml'), config);
}
type RpcSession = {
  readonly call: (method: string, params: unknown) => Promise<unknown>;
  readonly stop: () => Promise<void>;
};
async function openRpcSession(root: string, codexHome: string): Promise<RpcSession> {
  const child = Bun.spawn([executable!, 'app-server'], {
    env: isolatedEnv(root, codexHome),
    cwd: root,
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
          const newline = buffer.indexOf('\n');
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
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
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
      clientInfo: { name: 'aio-proxy-contract', version: '1' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    child.stdin.flush();
    return { call, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
async function rpcProbe(root: string, codexHome: string, loggedIn: boolean, proxyKey: string): Promise<ProbeResult> {
  const observedTokens: string[] = [];
  let inferenceRequest!: () => void;
  const inferenceArrived = new Promise<void>((resolve) => {
    inferenceRequest = resolve;
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      observedTokens.push(request.headers.get('authorization') ?? '');
      if (path === '/v1/models') return Response.json({ object: 'list', data: [] });
      inferenceRequest();
      return Response.json({ error: { message: 'contract probe' } }, { status: 503 });
    },
  });
  let session: RpcSession | undefined;
  try {
    await mkdir(join(root, 'tmp'), { recursive: true, mode: 0o700 });
    const port = server.port;
    if (port === undefined) throw new Error('Probe server did not expose a port');
    await writeConfig(codexHome, port, proxyKey);
    if (loggedIn) {
      await Bun.write(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: expectedLoginToken }) + '\n');
    }
    session = await openRpcSession(root, codexHome);
    const started = (await session.call('thread/start', {
      cwd: root,
      model: 'contract-model',
      modelProvider: 'contract-proxy',
      sandbox: 'read-only',
    })) as { thread?: { id?: string } };
    const threadId = started.thread?.id;
    if (threadId === undefined) throw new Error('thread/start returned no thread id');
    await session.call('turn/start', { threadId, input: [{ type: 'text', text: 'auth probe' }] });
    await Promise.race([
      inferenceArrived,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('No model request observed')), timeoutMs)),
    ]);
    const expected = `Bearer ${proxyKey}`;
    if (observedTokens.length === 0 || observedTokens.some((token) => token !== expected))
      throw new Error(`Authorization did not match expected test token (${loggedIn ? 'logged-in' : 'logged-out'})`);
    await session.stop();
    session = undefined;
    return {
      name: `${loggedIn ? 'logged-in' : 'logged-out'} / ${proxyKey}`,
      status: 'PASS',
      detail: 'model request used the configured proxy bearer',
    };
  } catch (error) {
    return {
      name: `${loggedIn ? 'logged-in' : 'logged-out'} / ${proxyKey}`,
      status: 'FAIL',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (session !== undefined) await session.stop();
    server.stop(true);
  }
}
async function writeMigrationConfig(codexHome: string, port: number, sqliteHome: string): Promise<void> {
  const provider = (name: string) => ({
    name,
    base_url: `http://127.0.0.1:${port}/v1`,
    wire_api: 'responses',
    requires_openai_auth: true,
    experimental_bearer_token: 'aio-proxy-local',
    request_max_retries: 0,
  });
  const config = Bun.TOML.stringify({
    model: 'contract-model',
    model_provider: 'source-proxy',
    cli_auth_credentials_store: 'file',
    sqlite_home: sqliteHome,
    model_providers: { 'source-proxy': provider('source-proxy'), 'aio-proxy': provider('aio-proxy') },
  });
  if (config === undefined) throw new Error('Failed to serialize Codex migration config');
  await Bun.write(join(codexHome, 'config.toml'), config);
}

async function migrationProbe(root: string, codexHome: string): Promise<ProbeResult> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ object: 'list', data: [] }),
  });
  let session: RpcSession | undefined;
  try {
    await mkdir(join(root, 'tmp'), { recursive: true, mode: 0o700 });
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const sqliteHome = join(root, 'sqlite-home');
    await mkdir(sqliteHome, { recursive: true, mode: 0o700 });
    const port = server.port;
    if (port === undefined) throw new Error('Migration probe server did not expose a port');
    await writeMigrationConfig(codexHome, port, sqliteHome);
    session = await openRpcSession(root, codexHome);
    const started = (await session.call('thread/start', {
      cwd: root,
      model: 'contract-model',
      modelProvider: 'source-proxy',
      historyMode: 'legacy',
      sandbox: 'read-only',
    })) as { thread?: { id?: string } };
    const threadId = started.thread?.id;
    if (threadId === undefined) throw new Error('thread/start returned no thread id');
    const turnResults: string[] = [];
    for (const text of ['migration probe round one', 'migration probe round two']) {
      try {
        await session.call('turn/start', { threadId, input: [{ type: 'text', text }] });
        turnResults.push('accepted');
      } catch {
        turnResults.push('rejected');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    let childThreadId: string | undefined;
    let forkResult = 'rejected';
    try {
      const forked = (await session.call('thread/fork', {
        threadId,
        modelProvider: 'source-proxy',
        model: 'contract-model',
        excludeTurns: true,
      })) as { thread?: { id?: string } };
      childThreadId = forked.thread?.id;
      forkResult = childThreadId === undefined ? 'accepted-without-id' : 'accepted';
    } catch {
      // The app-server may require a completed rollout before forking.
    }
    let archiveResult = 'not-attempted';
    if (childThreadId !== undefined) {
      try {
        await session.call('thread/archive', { threadId: childThreadId });
        archiveResult = 'accepted';
      } catch {
        archiveResult = 'rejected';
      }
    }
    const sourceList = (await session.call('thread/list', {
      modelProviders: ['source-proxy'],
      limit: 100,
      useStateDbOnly: true,
    })) as { data?: readonly { id?: string }[] };
    const targetList = (await session.call('thread/list', {
      modelProviders: ['aio-proxy'],
      limit: 100,
      useStateDbOnly: true,
    })) as { data?: readonly { id?: string }[] };
    const resumed = (await session.call('thread/resume', {
      threadId,
      modelProvider: 'aio-proxy',
      excludeTurns: true,
    })) as { modelProvider?: string };
    await session.call('thread/metadata/update', { threadId, isPinned: true });
    await session.stop();
    session = undefined;

    session = await openRpcSession(root, codexHome);
    const restartedSource = (await session.call('thread/list', {
      modelProviders: ['source-proxy'],
      limit: 100,
      useStateDbOnly: true,
    })) as { data?: readonly { id?: string }[] };
    const restartedTarget = (await session.call('thread/list', {
      modelProviders: ['aio-proxy'],
      limit: 100,
      useStateDbOnly: true,
    })) as { data?: readonly { id?: string }[] };
    const repairedList = (await session.call('thread/list', {
      modelProviders: ['source-proxy'],
      limit: 100,
      useStateDbOnly: false,
    })) as { data?: readonly { id?: string }[] };
    const restarted = (await session.call('thread/resume', { threadId, excludeTurns: true })) as {
      modelProvider?: string;
    };
    const sourceCount = sourceList.data?.filter((thread) => thread.id === threadId).length ?? 0;
    const targetCount = targetList.data?.filter((thread) => thread.id === threadId).length ?? 0;
    const restartedSourceCount = restartedSource.data?.filter((thread) => thread.id === threadId).length ?? 0;
    const restartedTargetCount = restartedTarget.data?.filter((thread) => thread.id === threadId).length ?? 0;
    const repairedCount = repairedList.data?.filter((thread) => thread.id === threadId).length ?? 0;
    const detail = `resume override=${resumed.modelProvider ?? 'unknown'}, after restart=${restarted.modelProvider ?? 'unknown'}, list source/target=${sourceCount}/${targetCount}, restart source/target=${restartedSourceCount}/${restartedTargetCount}, repaired source=${repairedCount}`;
    const storage = await inspectCodexStorage(codexHome, sqliteHome);
    return {
      name: 'native provider migration persistence',
      status: 'BLOCKED',
      detail: `${detail}; rounds=${turnResults.join('/')}, fork=${forkResult}, archive=${archiveResult}; ${storage}; metadata/update has no provider field, so no native migration write was attempted`,
    };
  } catch (error) {
    return {
      name: 'native provider migration persistence',
      status: 'BLOCKED',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (session !== undefined) await session.stop();
    server.stop(true);
  }
}

function schemaMethods(schema: Record<string, unknown>): string[] {
  const definitions = schema['definitions'];
  if (typeof definitions !== 'object' || definitions === null) return [];
  const definitionMap = definitions as Record<string, unknown>;
  const expected: Record<string, { required: readonly string[]; optional: readonly string[] }> = {
    ThreadStartParams: { required: [], optional: ['modelProvider', 'historyMode'] },
    ThreadResumeParams: { required: ['threadId'], optional: ['modelProvider'] },
    ThreadListParams: { required: [], optional: ['modelProviders', 'useStateDbOnly'] },
    ThreadMetadataUpdateParams: { required: ['threadId'], optional: ['isPinned', 'gitInfo'] },
  };
  const definitionOf = (name: string): Record<string, unknown> | undefined => {
    const definition = definitionMap[name];
    return typeof definition === 'object' && definition !== null ? (definition as Record<string, unknown>) : undefined;
  };
  const propertiesOf = (definition: Record<string, unknown>): Record<string, unknown> | undefined => {
    const properties = definition['properties'];
    return typeof properties === 'object' && properties !== null ? (properties as Record<string, unknown>) : undefined;
  };
  const requiredOf = (definition: Record<string, unknown>): readonly string[] | undefined => {
    const required = definition['required'];
    if (required === undefined) return [];
    return Array.isArray(required) && required.every((field): field is string => typeof field === 'string')
      ? required
      : undefined;
  };
  const hasType = (properties: Record<string, unknown>, name: string, expectedTypes: readonly string[]): boolean => {
    const property = properties[name];
    if (typeof property !== 'object' || property === null) return false;
    const type = (property as { type?: unknown }).type;
    return (
      (typeof type === 'string' && expectedTypes.length === 1 && type === expectedTypes[0]) ||
      (Array.isArray(type) &&
        type.length === expectedTypes.length &&
        expectedTypes.every((value) => type.includes(value)))
    );
  };
  const hasNullableAnyOfRef = (properties: Record<string, unknown>, name: string, reference: string): boolean => {
    const property = properties[name];
    if (typeof property !== 'object' || property === null) return false;
    const anyOf = (property as { anyOf?: unknown }).anyOf;
    return (
      Array.isArray(anyOf) &&
      anyOf.some(
        (entry) => typeof entry === 'object' && entry !== null && (entry as { $ref?: unknown })['$ref'] === reference,
      ) &&
      anyOf.some(
        (entry) => typeof entry === 'object' && entry !== null && (entry as { type?: unknown }).type === 'null',
      )
    );
  };
  const hasArrayItemsType = (properties: Record<string, unknown>, name: string, itemType: string): boolean => {
    const property = properties[name];
    if (typeof property !== 'object' || property === null) return false;
    const items = (property as { items?: unknown }).items;
    return typeof items === 'object' && items !== null && (items as { type?: unknown }).type === itemType;
  };
  const valid: string[] = [];
  for (const [name, fields] of Object.entries(expected)) {
    const definition = definitionOf(name);
    const properties = definition === undefined ? undefined : propertiesOf(definition);
    const required = definition === undefined ? undefined : requiredOf(definition);
    if (properties === undefined || required === undefined) continue;
    if (
      !fields.required.every((field) => required.includes(field)) ||
      fields.optional.some((field) => required.includes(field))
    )
      continue;
    if (
      !fields.required.every((field) => Object.hasOwn(properties, field)) ||
      !fields.optional.every((field) => Object.hasOwn(properties, field))
    )
      continue;
    const shapeValid =
      name === 'ThreadStartParams'
        ? hasType(properties, 'modelProvider', ['string', 'null']) &&
          hasNullableAnyOfRef(properties, 'historyMode', '#/definitions/ThreadHistoryMode')
        : name === 'ThreadResumeParams'
          ? hasType(properties, 'threadId', ['string']) && hasType(properties, 'modelProvider', ['string', 'null'])
          : name === 'ThreadListParams'
            ? hasType(properties, 'modelProviders', ['array', 'null']) &&
              hasArrayItemsType(properties, 'modelProviders', 'string') &&
              hasType(properties, 'useStateDbOnly', ['boolean'])
            : hasType(properties, 'threadId', ['string']) &&
              hasType(properties, 'isPinned', ['boolean', 'null']) &&
              hasNullableAnyOfRef(properties, 'gitInfo', '#/definitions/ThreadMetadataGitInfoUpdateParams') &&
              !Object.hasOwn(properties, 'modelProvider');
    if (shapeValid)
      valid.push(`${name}[required=${fields.required.join('|') || '(none)'};optional=${fields.optional.join('|')}]`);
  }
  return valid;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-contract-'));
  const codexHome = join(root, 'codex');
  const schemaDir = join(root, 'schema');
  const env = isolatedEnv(root, codexHome);
  const results: ProbeResult[] = [];
  let schemaContractValid = false;
  try {
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await mkdir(join(root, 'tmp'), { recursive: true, mode: 0o700 });
    const version = await command(['--version'], env, root);
    console.log(`executable: ${version.stdout.trim() || '(no version output)'}`);
    console.log(`version command exit: ${version.code}`);
    const help = await command(['app-server', '--help'], env, root);
    console.log(`app-server help exit: ${help.code}`);
    const loginHelp = await command(['login', '--help'], env, root);
    console.log(`isolated login help exit: ${loginHelp.code}`);
    console.log(`isolated login help first line: ${(loginHelp.stdout.split('\n')[0] ?? '').trim() || '(no stdout)'}`);
    await mkdir(schemaDir, { recursive: true, mode: 0o700 });
    const schema = await command(
      ['app-server', 'generate-json-schema', '--experimental', '--out', schemaDir],
      env,
      root,
    );
    console.log(`schema command exit: ${schema.code}`);
    if (schema.code === 0) {
      const schemaPath = join(schemaDir, 'codex_app_server_protocol.v2.schemas.json');
      const parsed = JSON.parse(await readFile(schemaPath, 'utf8')) as Record<string, unknown>;
      const verifiedFields = schemaMethods(parsed);
      schemaContractValid = verifiedFields.length === 4;
      console.log(`verified v2 schema fields: ${verifiedFields.join(', ') || '(none)'}`);
      if (!schemaContractValid) console.error('FAIL: required app-server schema contract is missing or invalid');
    }
    for (const loggedIn of [false, true]) {
      for (const proxyKey of ['test-proxy-key', 'aio-proxy-local']) {
        results.push(
          await rpcProbe(
            root,
            join(root, `${loggedIn ? 'codex-logged-in' : 'codex-logged-out'}-${proxyKey}`),
            loggedIn,
            proxyKey,
          ),
        );
      }
    }
    results.push(await migrationProbe(root, join(root, 'migration-codex')));
    for (const result of results) console.log(`${result.status}: ${result.name}: ${result.detail}`);
    console.log('migration: BLOCKED — this probe does not claim persistence without a restart/list/resume proof');
    if (
      version.code !== 0 ||
      help.code !== 0 ||
      loginHelp.code !== 0 ||
      schema.code !== 0 ||
      !schemaContractValid ||
      results.some((result) => result.status === 'FAIL' || result.status === 'BLOCKED')
    )
      process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
