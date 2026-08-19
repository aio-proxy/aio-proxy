import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const INSTALLATION_ID = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
const DEVICE_CODE = 'e'.repeat(43);
const INITIAL_ACCESS = `aio_agent_at_v1_${'a'.repeat(43)}`;
const INITIAL_REFRESH = `aio_agent_rt_v1_${'b'.repeat(43)}`;
const ROTATED_ACCESS = `aio_agent_at_v1_${'c'.repeat(43)}`;
const ROTATED_REFRESH = `aio_agent_rt_v1_${'d'.repeat(43)}`;
const versions = (process.env.OPENCODE_COMPAT_VERSIONS ?? '1.17.10,1.18.18')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

type CommandResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
type Stats = {
  readonly refreshExchanges: number;
  readonly inferenceAttempts: number;
  readonly anonymousCatalogCalls: number;
  readonly anonymousInferenceCalls: number;
};

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function startFakeProxy(options: { readonly rejectConsumedRefresh?: boolean } = {}) {
  let refreshExchanges = 0;
  let inferenceAttempts = 0;
  let anonymousCatalogCalls = 0;
  let anonymousInferenceCalls = 0;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorization = request.headers.get('authorization');
      if (url.pathname === '/oauth/device/code') {
        const body = new URLSearchParams(await request.text());
        check(body.get('client_id') === 'aio-proxy-opencode', 'wrong Device client');
        check(body.get('agent') === 'opencode', 'wrong Device target');
        check(body.get('installation_id') === INSTALLATION_ID, 'wrong installation');
        return Response.json(
          {
            device_code: DEVICE_CODE,
            user_code: 'ABCD-EFGH',
            verification_uri: `${url.origin}/dashboard/agents/authorize`,
            verification_uri_complete: `${url.origin}/dashboard/agents/authorize#code=ABCD-EFGH`,
            expires_in: 600,
            interval: 5,
          },
          { headers: { 'cache-control': 'no-store' } },
        );
      }
      if (url.pathname === '/oauth/token') {
        const body = new URLSearchParams(await request.text());
        check(body.get('client_id') === 'aio-proxy-opencode', 'wrong token client');
        if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
          check(body.get('device_code') === DEVICE_CODE, 'wrong device code');
          return Response.json({
            token_type: 'Bearer',
            access_token: INITIAL_ACCESS,
            refresh_token: INITIAL_REFRESH,
            expires_in: 900,
          });
        }
        check(body.get('grant_type') === 'refresh_token', 'wrong refresh grant');
        check(body.get('refresh_token') === INITIAL_REFRESH, 'wrong refresh token');
        if (options.rejectConsumedRefresh === true && refreshExchanges > 0) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        refreshExchanges += 1;
        await Bun.sleep(250);
        return Response.json({
          token_type: 'Bearer',
          access_token: ROTATED_ACCESS,
          refresh_token: ROTATED_REFRESH,
          expires_in: 900,
        });
      }
      if (url.pathname === '/v1/models') {
        if (authorization === null) anonymousCatalogCalls += 1;
        if (authorization !== `Bearer ${INITIAL_ACCESS}` && authorization !== `Bearer ${ROTATED_ACCESS}`)
          return new Response('', { status: 401 });
        check(url.searchParams.get('agent') === 'opencode', 'wrong catalog target');
        check(url.searchParams.get('schema_version') === '1', 'wrong catalog schema');
        return Response.json({
          schema_version: 1,
          agent: 'opencode',
          models: [
            {
              id: 'compat-model',
              name: 'Compat Model',
              reasoning: false,
              tool_call: true,
              temperature: false,
              attachment: false,
              input: ['text'],
              context_window: 8_192,
              max_output_tokens: 2_048,
            },
          ],
        });
      }
      if (url.pathname === '/v1/chat/completions') {
        inferenceAttempts += 1;
        if (authorization === null) anonymousInferenceCalls += 1;
        if (authorization === `Bearer ${INITIAL_ACCESS}`) return new Response('', { status: 401 });
        if (authorization !== `Bearer ${ROTATED_ACCESS}`) return new Response('', { status: 401 });
        const stream = [
          'data: {"id":"compat","object":"chat.completion.chunk","created":0,"model":"compat-model","choices":[{"index":0,"delta":{"role":"assistant","content":"compat-ok"},"finish_reason":null}]}\n\n',
          'data: {"id":"compat","object":"chat.completion.chunk","created":0,"model":"compat-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
          'data: [DONE]\n\n',
        ].join('');
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    stats: (): Stats => ({
      refreshExchanges,
      inferenceAttempts,
      anonymousCatalogCalls,
      anonymousInferenceCalls,
    }),
    stop: () => server.stop(true),
  };
}

async function runCommandRaw(version: string, root: string, args: string[]): Promise<CommandResult> {
  const configDir = join(root, 'config');
  const proc = Bun.spawn(['bunx', '--bun', `opencode-ai@${version}`, ...args], {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_STATE_HOME: join(root, 'state'),
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      BROWSER: 'true',
      CI: '1',
      NO_COLOR: '1',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  // Isolated HOME forces OpenCode to install `@ai-sdk/openai-compatible` on first boot.
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, 180_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);
  check(!timedOut, `${version} timed out: ${args.join(' ')}`);
  return { exitCode, stdout, stderr };
}

async function runCommand(version: string, root: string, args: string[]): Promise<CommandResult> {
  const result = await runCommandRaw(version, root, args);
  check(result.exitCode === 0, `${version} ${args.join(' ')} failed (${result.exitCode})\n${result.stderr}`);
  return result;
}

async function installManagedPlugin(root: string, endpoint: string): Promise<void> {
  const configDir = join(root, 'config');
  const managedDir = join(configDir, 'plugins', 'aio-proxy');
  await mkdir(managedDir, { recursive: true });
  await copyFile(new URL('../dist/index.js', import.meta.url), join(managedDir, 'index.js'));
  await writeFile(join(managedDir, 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
  await writeFile(
    join(managedDir, '.aio-proxy-managed.json'),
    JSON.stringify({
      format: 1,
      managedBy: 'aio-proxy',
      agent: 'opencode',
      installationId: INSTALLATION_ID,
      adapterVersion: '1.2.3',
      endpoint,
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(configDir, 'plugins', 'aio-proxy.js'),
    `// aio-proxy-managed:v1:${INSTALLATION_ID}\nexport { default } from "./aio-proxy/index.js";\n`,
    { mode: 0o600 },
  );
}

async function runVersion(version: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `aio-proxy-opencode-${version}-`));
  const proxy = startFakeProxy();
  try {
    await installManagedPlugin(root, proxy.endpoint);

    await runCommand(version, root, ['auth', 'login', '--provider', 'aio-proxy', '--method', 'aio-proxy']);
    const models = await runCommand(version, root, ['models', 'aio-proxy']);
    check(models.stdout.includes('aio-proxy/compat-model'), `${version} did not publish compat-model`);
    const authPath = join(root, 'data', 'opencode', 'auth.json');
    const auth = (await Bun.file(authPath).json()) as Record<
      string,
      {
        access: string;
        refresh: string;
        expires: number;
      }
    >;
    check(auth['aio-proxy'] !== undefined, `${version} did not persist aio-proxy auth`);
    auth['aio-proxy'].expires = 0;
    await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
    const inferences = await Promise.all([
      runCommand(version, root, ['run', '--model', 'aio-proxy/compat-model', 'compat']),
      runCommand(version, root, ['run', '--model', 'aio-proxy/compat-model', 'compat']),
    ]);
    for (const inference of inferences) {
      check(`${inference.stdout}\n${inference.stderr}`.includes('compat-ok'), `${version} did not return compat-ok`);
    }
    const stats = proxy.stats();
    check(
      stats.refreshExchanges >= 1 && stats.refreshExchanges <= 2,
      `${version} refresh count was ${stats.refreshExchanges}`,
    );
    // Each public `run` issues a session-title completion plus the user prompt.
    check(stats.inferenceAttempts === 4, `${version} inference count was ${stats.inferenceAttempts}`);
    check(stats.anonymousCatalogCalls === 0, `${version} made an anonymous catalog request`);
    check(stats.anonymousInferenceCalls === 0, `${version} made an anonymous inference request`);
  } finally {
    proxy.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function runReceivePersistFailure(version: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `aio-proxy-opencode-crash-${version}-`));
  const proxy = startFakeProxy({ rejectConsumedRefresh: true });
  const authPath = join(root, 'data', 'opencode', 'auth.json');
  const authDir = dirname(authPath);
  try {
    await installManagedPlugin(root, proxy.endpoint);
    await runCommand(version, root, ['auth', 'login', '--provider', 'aio-proxy', '--method', 'aio-proxy']);
    const auth = (await Bun.file(authPath).json()) as Record<
      string,
      {
        access: string;
        refresh: string;
        expires: number;
      }
    >;
    const stored = auth['aio-proxy'];
    check(stored !== undefined, `${version} did not persist crash fixture auth`);
    stored.expires = 0;
    await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });

    // The refresh response is received, then client.auth.set() fails at the
    // persistence boundary. Directory and file permissions cover both direct
    // writes and atomic-replace implementations.
    await chmod(authPath, 0o400);
    await chmod(authDir, 0o500);
    const persistenceFailure = await runCommandRaw(version, root, [
      'run',
      '--model',
      'aio-proxy/compat-model',
      'compat',
    ]);
    check(persistenceFailure.exitCode !== 0, `${version} unexpectedly succeeded while auth persistence was blocked`);
    await chmod(authDir, 0o700);
    await chmod(authPath, 0o600);

    const unchanged = (await Bun.file(authPath).json()) as typeof auth;
    check(
      unchanged['aio-proxy']?.refresh === INITIAL_REFRESH,
      `${version} replaced the old refresh credential before persistence succeeded`,
    );
    // Default `run` wraps plugin failures as UnknownError; --print-logs is the
    // public V1 switch that surfaces the re-login diagnostic.
    const relaunch = await runCommandRaw(version, root, [
      'run',
      '--print-logs',
      '--model',
      'aio-proxy/compat-model',
      'compat',
    ]);
    const diagnostic = `${relaunch.stdout}\n${relaunch.stderr}`;
    check(relaunch.exitCode !== 0, `${version} silently reused a consumed refresh credential`);
    check(
      /invalid_grant|log[ -]?in|required authentication/iu.test(diagnostic),
      `${version} did not emit a re-login diagnostic after invalid_grant:\n${diagnostic}`,
    );

    const stats = proxy.stats();
    check(stats.refreshExchanges === 1, `${version} created ${stats.refreshExchanges} rotated pairs`);
    check(stats.anonymousCatalogCalls === 0, `${version} made an anonymous catalog request`);
    check(stats.anonymousInferenceCalls === 0, `${version} made an anonymous inference request`);
  } finally {
    await chmod(authDir, 0o700).catch(() => {});
    await chmod(authPath, 0o600).catch(() => {});
    proxy.stop();
    await rm(root, { recursive: true, force: true });
  }
}

for (const version of versions) {
  await runVersion(version);
  await runReceivePersistFailure(version);
}
