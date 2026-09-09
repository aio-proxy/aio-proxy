import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
if (executable === undefined || executable.trim() === '') {
  console.error('FAIL: Pass the Codex executable explicitly');
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
    PATH: process.env.PATH ?? '',
    HOME: root,
    CODEX_HOME: codexHome,
    TMPDIR: join(root, 'tmp'),
  };
}

async function writeConfig(codexHome: string, port: number, proxyKey: string): Promise<void> {
  await Bun.write(
    join(codexHome, 'config.toml'),
    Bun.TOML.stringify({
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
    }),
  );
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
  let observedToken: string | null = null;
  let inferenceRequest!: () => void;
  const inferenceArrived = new Promise<void>((resolve) => {
    inferenceRequest = resolve;
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/v1/models') return Response.json({ object: 'list', data: [] });
      observedToken = request.headers.get('authorization');
      inferenceRequest();
      return Response.json({ error: { message: 'contract probe' } }, { status: 503 });
    },
  });
  let session: RpcSession | undefined;
  try {
    await mkdir(join(root, 'tmp'), { recursive: true, mode: 0o700 });
    await writeConfig(codexHome, server.port, proxyKey);
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
    if (observedToken !== expected)
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

async function writeMigrationConfig(codexHome: string, port: number): Promise<void> {
  const provider = (name: string) => ({
    name,
    base_url: `http://127.0.0.1:${port}/v1`,
    wire_api: 'responses',
    requires_openai_auth: true,
    experimental_bearer_token: 'aio-proxy-local',
    request_max_retries: 0,
  });
  await Bun.write(
    join(codexHome, 'config.toml'),
    Bun.TOML.stringify({
      model: 'contract-model',
      model_provider: 'source-proxy',
      cli_auth_credentials_store: 'file',
      model_providers: { 'source-proxy': provider('source-proxy'), 'aio-proxy': provider('aio-proxy') },
    }),
  );
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
    await writeMigrationConfig(codexHome, server.port);
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
    try {
      await session.call('turn/start', { threadId, input: [{ type: 'text', text: 'migration probe' }] });
    } catch {
      // The synthetic upstream intentionally cannot complete inference; the rollout may still be persisted.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
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
    const restarted = (await session.call('thread/resume', { threadId, excludeTurns: true })) as {
      modelProvider?: string;
    };
    const sourceCount = sourceList.data?.filter((thread) => thread.id === threadId).length ?? 0;
    const targetCount = targetList.data?.filter((thread) => thread.id === threadId).length ?? 0;
    const restartedSourceCount = restartedSource.data?.filter((thread) => thread.id === threadId).length ?? 0;
    const restartedTargetCount = restartedTarget.data?.filter((thread) => thread.id === threadId).length ?? 0;
    const detail = `resume override=${resumed.modelProvider ?? 'unknown'}, after restart=${restarted.modelProvider ?? 'unknown'}, list source/target=${sourceCount}/${targetCount}, restart source/target=${restartedSourceCount}/${restartedTargetCount}`;
    return {
      name: 'native provider migration persistence',
      status: 'BLOCKED',
      detail: `${detail}; metadata/update has no provider field, so no native migration write was attempted`,
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
  const methods = ['ThreadStartParams', 'ThreadResumeParams', 'ThreadListParams', 'ThreadMetadataUpdateParams'];
  return methods.filter((name) => Object.hasOwn(definitions, name));
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-contract-'));
  const codexHome = join(root, 'codex');
  const schemaDir = join(root, 'schema');
  const env = isolatedEnv(root, codexHome);
  const results: ProbeResult[] = [];
  try {
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await mkdir(join(root, 'tmp'), { recursive: true, mode: 0o700 });
    const version = await command(['--version'], env, root);
    console.log(`executable: ${version.stdout.trim() || '(no version output)'}`);
    console.log(`version command exit: ${version.code}`);
    const help = await command(['app-server', '--help'], env, root);
    console.log(`app-server help exit: ${help.code}`);
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
      console.log(`verified v2 schema methods: ${schemaMethods(parsed).join(', ') || '(none)'}`);
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
      schema.code !== 0 ||
      results.some((result) => result.status === 'FAIL')
    )
      process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
