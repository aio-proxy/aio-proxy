/** Explicit, isolated acceptance: bun <this file> --codex-bin <absolute path> --count 50|100. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { clearModelsCache, fileCacheStorage } from '@aio-proxy/core';
import { type CodexCatalog, createServer } from '@aio-proxy/server';

import officialFixture from '../../../../../server/src/server/list-models/codex-client-models/fixtures/official-models-2026-10-01.json';
import type { CodexLocation } from '../contracts';
import { resolveCodexLocation } from '../location';
import { commitCodexSetup } from '../setup';

const args = Bun.argv.slice(2);
const binary = args[args.indexOf('--codex-bin') + 1];
const count = Number(args[args.indexOf('--count') + 1]);
assert(args.length === 4 && args.includes('--codex-bin') && args.includes('--count'));
assert(binary !== undefined && isAbsolute(binary), '--codex-bin must be an absolute path');
assert(count === 50 || count === 100, '--count must be 50 or 100');

const TIMEOUT_MS = 25_000;
async function bounded<T>(promise: Promise<T>, step: string, ms = TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout: ${step}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function startClient(codexHome: string, workspace: string, aioHome: string) {
  const child = Bun.spawn([binary!, 'app-server', '--listen', 'stdio://'], {
    cwd: workspace,
    // Do not inherit credentials, proxy settings, or another Codex/SQLite home.
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: codexHome,
      CODEX_HOME: codexHome,
      CODEX_SQLITE_HOME: codexHome,
      AIO_PROXY_HOME: aioHome,
      RUST_LOG: 'error',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let nextId = 0;
  let step = 'spawn';
  let stderrBytes = 0;
  let readerFailure = false;
  const notifications: string[] = [];
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const send = (value: unknown) => {
    child.stdin.write(`${JSON.stringify(value)}\n`);
    child.stdin.flush();
  };
  const stdout = (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line);
        if (typeof message.id === 'number' && pending.has(message.id)) {
          const waiter = pending.get(message.id)!;
          pending.delete(message.id);
          if (message.error !== undefined) waiter.reject(new Error(`RPC error: ${step}, code ${message.error.code}`));
          else waiter.resolve(message.result);
        } else if (typeof message.method === 'string') {
          notifications.push(message.method);
          if (notifications.length > 20) notifications.shift();
          // This test authorizes no tools or external side effects.
          if (message.id !== undefined)
            send({ id: message.id, error: { code: -32601, message: 'Smoke forbids tools' } });
        }
      }
    }
  })().catch(() => {
    readerFailure = true;
    for (const waiter of pending.values()) waiter.reject(new Error(`RPC stream failed: ${step}`));
    pending.clear();
  });
  const stderr = (async () => {
    for await (const chunk of child.stderr) stderrBytes += chunk.byteLength;
  })().catch(() => {});
  const rpc = async (method: string, params: unknown) => {
    step = method;
    const id = ++nextId;
    const result = new Promise<any>((resolve, reject) => pending.set(id, { resolve, reject }));
    send({ id, method, params });
    try {
      return await bounded(result, method);
    } finally {
      pending.delete(id);
    }
  };
  return {
    rpc,
    initialized: () => send({ method: 'initialized' }),
    diagnostics: () => ({ step, exitCode: child.exitCode, readerFailure, stderrBytes, notifications }),
    async close() {
      child.kill('SIGTERM');
      try {
        await bounded(child.exited, 'process cleanup', 3_000);
      } catch {
        child.kill('SIGKILL');
        await bounded(child.exited, 'forced process cleanup', 3_000);
      }
      await Promise.all([stdout, stderr]);
    },
  };
}

function instructions(row: Record<string, any>): string {
  return row['model_messages']?.['instructions_template'] ?? row['base_instructions'];
}

function mockResponse(): Response {
  const response = {
    id: 'resp_smoke',
    object: 'response',
    status: 'completed',
    output: [],
    usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
  };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress' } },
    { type: 'response.completed', response },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function prepareClientCatalog(mode: 'local' | 'remote', location: CodexLocation, endpoint: string) {
  let expected: CodexCatalog;
  let catalogBytes: number;
  if (mode === 'local') {
    await commitCodexSetup(
      {
        providerId: 'smoke',
        auth: {
          mode: 'keep-chatgpt',
          keys: {
            choices: [],
            resolve: async () => ({ token: 'smoke-placeholder', kind: 'placeholder', verified: false }),
          },
          selection: { kind: 'none' },
        },
      },
      {
        location,
        endpoint,
        adapterVersion: 'smoke',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        onDevice: async () => {
          throw new Error('Unexpected device authorization');
        },
      },
    );
    const config = Bun.TOML.parse(await Bun.file(location.configPath).text()) as Record<string, unknown>;
    assert.equal(typeof config['model_catalog_json'], 'string');
    const bytes = await Bun.file(config['model_catalog_json'] as string).text();
    expected = JSON.parse(bytes);
    catalogBytes = Buffer.byteLength(bytes);
    // Keep the public setup configuration; disable unrelated plugin discovery only.
    const setupText = await Bun.file(location.configPath).text();
    assert(setupText.includes('[features]'));
    await Bun.write(location.configPath, setupText.replace('[features]', '[features]\nremote_plugin = false'));
    const isolatedConfig = Bun.TOML.parse(await Bun.file(location.configPath).text()) as {
      features: { remote_plugin?: boolean };
    };
    assert.equal(isolatedConfig.features.remote_plugin, false);
    if (count === 100) assert(catalogBytes > 1_048_576, '100-row full acceptance must exceed the HTTP limit');
  } else {
    const response = await fetch(`${endpoint}/v1/models?client_version=smoke`);
    assert(response.ok, 'Real compact endpoint must succeed');
    const bytes = await response.text();
    expected = JSON.parse(bytes);
    catalogBytes = Buffer.byteLength(bytes);
    assert(catalogBytes <= 786_432, '50-row compact catalog exceeds its fixture budget');
    await Bun.write(
      location.configPath,
      `model_provider = "smoke"\n[model_providers.smoke]\nname = "Smoke"\nbase_url = "${endpoint}/v1"\nmodel_catalog_url = "${endpoint}/v1/models"\nwire_api = "responses"\nrequires_openai_auth = false\nexperimental_bearer_token = "smoke-placeholder"\n[features]\napi_key_model_discovery = true\nremote_plugin = false\n`,
    );
  }
  return { expected, catalogBytes };
}

function createProxy(modelIds: string[], aioHome: string) {
  return createServer({
    config: {
      server: { host: '127.0.0.1' },
      providers: {
        smoke: {
          kind: 'api',
          protocol: 'openai-response',
          baseURL: 'http://127.0.0.1:1',
          apiKey: 'smoke-placeholder',
          models: modelIds,
        },
      },
      router: {
        models: Object.fromEntries(
          modelIds.map((id) => [id, { metadata: { capabilities: { modalities: { output: ['text'] } } } }]),
        ),
      },
    },
    dbHome: aioHome,
    host: '127.0.0.1',
    watchConfig: false,
    autoUpdate: {
      isManagedService: () => false,
      applyUpdate: async () => 'unchanged',
      fetchLatest: async () => '0.0.0',
    },
  });
}

async function runCase(mode: 'local' | 'remote'): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-catalog-smoke-'));
  const codexHome = join(root, 'codex');
  const aioHome = join(root, 'aio');
  const workspace = join(root, 'workspace');
  const previousAioHome = process.env['AIO_PROXY_HOME'];
  const previousCodexHome = process.env['CODEX_HOME'];
  const originalFetch = globalThis.fetch;
  let blockedNetwork = 0;
  const blockedHosts: string[] = [];
  let catalogGets = 0;
  const captures: { model: string; instructions: unknown }[] = [];
  let client: ReturnType<typeof startClient> | undefined;
  let app: Awaited<ReturnType<typeof createServer>> | undefined;
  let listener: ReturnType<typeof Bun.serve> | undefined;
  let caseError: unknown;
  let failed = false;
  const cleanupErrors: unknown[] = [];
  try {
    await Promise.all([mkdir(codexHome), mkdir(aioHome), mkdir(workspace)]);
    process.env['AIO_PROXY_HOME'] = aioHome;
    process.env['CODEX_HOME'] = codexHome;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname !== '127.0.0.1') {
          blockedNetwork++;
          blockedHosts.push(url.hostname);
          throw new Error('Smoke forbids non-loopback fetch');
        }
        return originalFetch(input, init);
      },
      { preconnect: originalFetch.preconnect },
    );
    clearModelsCache();
    // Change transport flags only on independent copies, never on the shipped fixture.
    const official = officialFixture.models.map((row) => ({
      ...structuredClone(row),
      use_responses_lite: false,
      prefer_websockets: false,
    }));
    const modelIds = [
      ...official.map((row) => row.slug),
      ...Array.from({ length: count - official.length }, (_, index) => `smoke-text-${index}`),
    ];
    await fileCacheStorage.setItem('codex-models', { models: official });
    await fileCacheStorage.setItem('models-dev-providers', { openrouter: { models: {} } });
    app = await createProxy(modelIds, aioHome);
    listener = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        assert(url.hostname === '127.0.0.1');
        if (request.method === 'GET' && url.pathname === '/v1/models') catalogGets++;
        if (request.method === 'POST') {
          assert.equal(url.pathname, '/v1/responses', 'Only local Responses generation is allowed');
          const payload = await request.json();
          captures.push({ model: payload.model, instructions: payload.instructions });
          return mockResponse();
        }
        return app!.fetch(request);
      },
    });
    const endpoint = `http://127.0.0.1:${listener.port}`;
    const location = resolveCodexLocation(codexHome, { CODEX_HOME: codexHome, HOME: codexHome });
    const { expected, catalogBytes } = await prepareClientCatalog(mode, location, endpoint);
    assert.equal(expected.models.length, count);
    catalogGets = 0;
    captures.length = 0;
    client = startClient(codexHome, workspace, aioHome);
    await client.rpc('initialize', {
      clientInfo: { name: 'aio_catalog_smoke', version: '1.0' },
      capabilities: { experimentalApi: true },
    });
    client.initialized();
    const listed = await client.rpc('model/list', { limit: 100 });
    assert.equal(listed.data.length, count, `${mode} client model count`);
    assert.equal(listed.nextCursor, null, 'All models should fit one page');
    assert.deepEqual(
      listed.data.map((row: { id: string }) => row.id).sort(),
      modelIds.toSorted(),
      'Model IDs must match the configured routes',
    );
    const officialRow = expected.models.find((row) => row['slug'] === 'gpt-5.6-sol')!;
    const synthesized = expected.models.find((row) => row['slug'] === 'smoke-text-0')!;
    assert(
      instructions(officialRow) === instructions(official.find((row) => row.slug === 'gpt-5.6-sol')!),
      'Official prompt projection must be verbatim',
    );
    for (const row of [synthesized, officialRow]) {
      const thread = await client.rpc('thread/start', {
        cwd: workspace,
        ephemeral: true,
        model: row['slug'],
        modelProvider: 'smoke',
      });
      await client.rpc('turn/start', {
        threadId: thread.thread.id,
        input: [{ type: 'text', text: 'Reply OK without using tools.' }],
      });
      const captureSignal = AbortSignal.timeout(TIMEOUT_MS);
      const capture = await bounded(
        (async () => {
          while (!captures.some((item) => item.model === row['slug'])) {
            captureSignal.throwIfAborted();
            await Bun.sleep(20);
          }
          return captures.find((item) => item.model === row['slug'])!;
        })(),
        `Responses POST ${row['slug']}`,
      );
      assert(capture.instructions === instructions(row), `${mode} ${row['slug']} instructions must match exactly`);
    }
    if (mode === 'local') assert.equal(catalogGets, 0, 'Local catalog must avoid model directory GET');
    else assert(catalogGets > 0, 'Remote client must load the real compact endpoint');
    assert.equal(blockedNetwork, 0, 'No proxy network fetch may target another host');
    console.log(
      JSON.stringify({
        mode,
        models: listed.data.length,
        catalogBytes,
        catalogGets,
        synthesizedInstructionBytes: Buffer.byteLength(instructions(synthesized)),
        officialInstructionBytes: Buffer.byteLength(instructions(officialRow)),
        instructionsEqual: true,
        blockedNetwork,
      }),
    );
  } catch (error) {
    // Never print full RPC bodies, prompts, credentials, or request payloads.
    console.error(
      JSON.stringify({
        mode,
        count,
        catalogGets,
        captures: captures.length,
        blockedNetwork,
        blockedHosts,
        rpc: client?.diagnostics(),
      }),
    );
    caseError = error;
    failed = true;
  } finally {
    const cleanup = await Promise.allSettled([
      client?.close(),
      listener?.stop(true),
      Promise.resolve().then(() => app?.close()),
    ]);
    globalThis.fetch = originalFetch;
    clearModelsCache();
    if (previousAioHome === undefined) delete process.env['AIO_PROXY_HOME'];
    else process.env['AIO_PROXY_HOME'] = previousAioHome;
    if (previousCodexHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previousCodexHome;
    const removal = await Promise.allSettled([rm(root, { recursive: true, force: true })]);
    for (const result of [...cleanup, ...removal]) if (result.status === 'rejected') cleanupErrors.push(result.reason);
  }
  if (failed) throw caseError;
  if (cleanupErrors.length > 0) throw new Error('Smoke cleanup failed');
}

const version = Bun.spawnSync([binary, '--version'], {
  env: { PATH: process.env['PATH'] ?? '' },
  timeout: TIMEOUT_MS,
  killSignal: 'SIGKILL',
});
assert.equal(version.exitCode, 0, 'Codex --version failed');
console.log(version.stdout.toString().trim());
await runCase('local');
if (count === 50) await runCase('remote');
