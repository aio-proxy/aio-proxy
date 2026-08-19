/* eslint-disable max-lines -- one real-host fixture; do not split the matrix */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const INSTALLATION_ID = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
const DEVICE_CODE = 'e'.repeat(43);
const INITIAL_ACCESS = `aio_agent_at_v1_${'a'.repeat(43)}`;
const INITIAL_REFRESH = `aio_agent_rt_v1_${'b'.repeat(43)}`;
const ROTATED_ACCESS = `aio_agent_at_v1_${'c'.repeat(43)}`;
const ROTATED_REFRESH = `aio_agent_rt_v1_${'d'.repeat(43)}`;
const PRINT_ARGS = ['-p', '--no-session', '--model', 'aio-proxy/compat-model', 'compat'] as const;

type Target = 'pi' | 'omp';
type Scenario = 'concurrent' | 'crash';
type Host = {
  readonly target: Target;
  readonly packageName: string;
  readonly version: string;
  readonly binary: 'pi' | 'omp';
  readonly manifestEntry: 'official-pi.js' | 'omp.js';
};
type CommandResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
type Stats = {
  readonly refreshRequests: number;
  readonly rotatedPairs: number;
  readonly successfulInferenceCalls: number;
  readonly anonymousCatalogCalls: number;
  readonly anonymousInferenceCalls: number;
  readonly oldRefreshAfterReject: number;
  readonly rotatedRefreshRequests: number;
  readonly disallowedAuthorizationCalls: number;
};
type OAuthCredential = { readonly access: string; readonly refresh: string; readonly expires: number };
type HostModel = Readonly<Record<string, unknown>>;
type ProviderRegistration = {
  readonly name: string;
  readonly config: {
    readonly oauth: {
      readonly login: (
        callbacks:
          | {
              readonly onDeviceCode: (value: unknown) => void;
              readonly onPrompt: () => Promise<string>;
              readonly onSelect: () => Promise<undefined>;
              readonly signal: AbortSignal;
            }
          | {
              readonly onAuth: (value: { readonly url?: string }) => void;
              readonly onPrompt: () => Promise<string>;
              readonly onSelect: () => Promise<undefined>;
              readonly signal: AbortSignal;
            },
      ) => Promise<OAuthCredential>;
      readonly refreshToken?: (credential: OAuthCredential, signal?: AbortSignal) => Promise<OAuthCredential>;
      readonly getApiKey: (credential: OAuthCredential) => string;
    };
    readonly refreshModels?: (context: Readonly<Record<string, unknown>>) => Promise<readonly HostModel[]>;
    readonly fetchDynamicModels?: (apiKey: string | undefined) => Promise<readonly HostModel[]>;
  };
  readonly extensionPath?: string;
  readonly sourceId?: string;
};
type HostApi = {
  readonly discoverAndLoadExtensions: (...args: unknown[]) => Promise<{
    readonly errors: readonly unknown[];
    readonly runtime: { readonly pendingProviderRegistrations: readonly ProviderRegistration[] };
  }>;
  readonly discoverAuthStorage?: (agentDir: string) => Promise<{
    readonly set: (provider: string, credential: OAuthCredential & { readonly type: 'oauth' }) => Promise<void>;
    readonly close: () => void;
  }>;
};

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const versions = (name: string, fallback: string): string[] => [
  ...new Set(
    (process.env[name] ?? fallback)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  ),
];

const hosts: Host[] = [
  ...versions('PI_OFFICIAL_COMPAT_VERSIONS', '0.84.2').map((version) => ({
    target: 'pi' as const,
    packageName: '@earendil-works/pi-coding-agent',
    version,
    binary: 'pi' as const,
    manifestEntry: 'official-pi.js' as const,
  })),
  ...versions('OMP_COMPAT_VERSIONS', '17.3.7').map((version) => ({
    target: 'omp' as const,
    packageName: '@oh-my-pi/pi-coding-agent',
    version,
    binary: 'omp' as const,
    manifestEntry: 'omp.js' as const,
  })),
];

function isolatedEnv(root: string, agentDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    PI_CODING_AGENT_DIR: agentDir,
    BROWSER: 'true',
    CI: '1',
    NO_COLOR: '1',
  };
  delete env.OMP_AUTH_BROKER_URL;
  delete env.OMP_PROFILE;
  delete env.PI_OFFLINE;
  return env;
}

async function run(
  command: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 60_000,
): Promise<CommandResult> {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);
  check(!timedOut, `timed out: ${command.join(' ')}`);
  return { stdout, stderr, exitCode };
}

function startFakeProxy(target: Target) {
  const clientId = `aio-proxy-${target}`;
  let refreshRequests = 0;
  let rotatedPairs = 0;
  let successfulInferenceCalls = 0;
  let anonymousCatalogCalls = 0;
  let anonymousInferenceCalls = 0;
  let oldRefreshAfterReject = 0;
  let rotatedRefreshRequests = 0;
  let disallowedAuthorizationCalls = 0;
  let rotated = false;
  let rejectOldRefresh = false;

  const assertAllowedInstallationAuthorization = (
    authorization: string | null,
    surface: 'catalog' | 'inference',
  ): void => {
    if (authorization === null) return;
    if (authorization === `Bearer ${INITIAL_ACCESS}` || authorization === `Bearer ${ROTATED_ACCESS}`) return;
    disallowedAuthorizationCalls += 1;
    check(false, `${surface} used a disallowed Authorization value`);
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorization = request.headers.get('authorization');
      if (url.pathname === '/oauth/device/code') {
        const body = new URLSearchParams(await request.text());
        check(body.get('client_id') === clientId, 'wrong Device client');
        check(body.get('agent') === target, 'wrong Device target');
        check(body.get('installation_id') === INSTALLATION_ID, 'wrong installation');
        check(body.get('adapter_version') === '1.2.3', 'wrong adapter version');
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
        check(body.get('client_id') === clientId, 'wrong token client');
        if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
          check(body.get('device_code') === DEVICE_CODE, 'wrong device code');
          return Response.json(
            {
              token_type: 'Bearer',
              access_token: INITIAL_ACCESS,
              refresh_token: INITIAL_REFRESH,
              expires_in: 900,
            },
            { headers: { 'cache-control': 'no-store' } },
          );
        }
        check(body.get('grant_type') === 'refresh_token', 'wrong refresh grant');
        refreshRequests += 1;
        const refreshToken = body.get('refresh_token');
        if (refreshToken === INITIAL_REFRESH) {
          if (rejectOldRefresh) {
            oldRefreshAfterReject += 1;
            return Response.json(
              { error: 'invalid_grant', error_description: 'refresh token already consumed' },
              { status: 400, headers: { 'cache-control': 'no-store' } },
            );
          }
          if (!rotated) {
            rotated = true;
            rotatedPairs += 1;
          }
          await Bun.sleep(250);
          return Response.json(
            {
              token_type: 'Bearer',
              access_token: ROTATED_ACCESS,
              refresh_token: ROTATED_REFRESH,
              expires_in: 900,
            },
            { headers: { 'cache-control': 'no-store' } },
          );
        }
        if (refreshToken === ROTATED_REFRESH) {
          rotatedRefreshRequests += 1;
          return Response.json(
            {
              token_type: 'Bearer',
              access_token: ROTATED_ACCESS,
              refresh_token: ROTATED_REFRESH,
              expires_in: 900,
            },
            { headers: { 'cache-control': 'no-store' } },
          );
        }
        check(false, 'unexpected refresh token');
      }
      if (url.pathname === '/v1/models') {
        if (authorization === null) anonymousCatalogCalls += 1;
        assertAllowedInstallationAuthorization(authorization, 'catalog');
        if (authorization !== `Bearer ${INITIAL_ACCESS}` && authorization !== `Bearer ${ROTATED_ACCESS}`) {
          return new Response('', { status: 401 });
        }
        check(url.searchParams.get('agent') === target, 'wrong catalog target');
        check(url.searchParams.get('schema_version') === '1', 'wrong catalog schema');
        return Response.json({
          schema_version: 1,
          agent: target,
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
        if (authorization === null) anonymousInferenceCalls += 1;
        assertAllowedInstallationAuthorization(authorization, 'inference');
        if (authorization === `Bearer ${INITIAL_ACCESS}`) return new Response('', { status: 401 });
        if (authorization !== `Bearer ${ROTATED_ACCESS}`) return new Response('', { status: 401 });
        successfulInferenceCalls += 1;
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
    rejectOldRefresh: () => {
      rejectOldRefresh = true;
    },
    stats: (): Stats => ({
      refreshRequests,
      rotatedPairs,
      successfulInferenceCalls,
      anonymousCatalogCalls,
      anonymousInferenceCalls,
      oldRefreshAfterReject,
      rotatedRefreshRequests,
      disallowedAuthorizationCalls,
    }),
    stop: () => server.stop(true),
  };
}

async function installManagedPlugin(agentDir: string, target: Target, endpoint: string): Promise<void> {
  const pluginDir = join(agentDir, 'extensions', 'aio-proxy');
  await mkdir(join(pluginDir, 'dist'), { recursive: true });
  await Promise.all([
    copyFile(new URL('../dist/official-pi.js', import.meta.url), join(pluginDir, 'dist', 'official-pi.js')),
    copyFile(new URL('../dist/omp.js', import.meta.url), join(pluginDir, 'dist', 'omp.js')),
  ]);
  await writeFile(
    join(pluginDir, 'package.json'),
    JSON.stringify({
      name: '@aio-proxy/pi-provider',
      type: 'module',
      pi: { extensions: ['./dist/official-pi.js'] },
      omp: { extensions: ['./dist/omp.js'] },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(pluginDir, '.aio-proxy-managed.json'),
    JSON.stringify({
      format: 1,
      managedBy: 'aio-proxy',
      agent: target,
      installationId: INSTALLATION_ID,
      adapterVersion: '1.2.3',
      endpoint,
    }),
    { mode: 0o600 },
  );
}

async function seedExpiredCredential(
  target: Target,
  hostApi: HostApi,
  agentDir: string,
  credential: OAuthCredential,
): Promise<void> {
  // OMP treats expires === 0 as force-remint; a past-but-nonzero expiry still fails peek.
  const expires = target === 'omp' ? Date.now() - 1 : 0;
  const expired = { type: 'oauth' as const, ...credential, expires };
  if (target === 'pi') {
    await writeFile(join(agentDir, 'auth.json'), `${JSON.stringify({ 'aio-proxy': expired }, null, 2)}\n`, {
      mode: 0o600,
    });
    return;
  }
  const discoverAuthStorage = hostApi.discoverAuthStorage;
  check(discoverAuthStorage !== undefined, 'OMP did not export discoverAuthStorage');
  const authStorage = await discoverAuthStorage(agentDir);
  try {
    await authStorage.set('aio-proxy', expired);
  } finally {
    authStorage.close();
  }
}

async function runProbe(
  target: Target,
  packageRoot: string,
  root: string,
  agentDir: string,
  scenario: Scenario,
  manifestEntry: string,
): Promise<void> {
  const packageEntry = target === 'pi' ? join(packageRoot, 'dist', 'index.js') : join(packageRoot, 'src', 'index.ts');
  const hostApi = (await import(pathToFileURL(packageEntry).href)) as HostApi;
  const loaded =
    target === 'pi'
      ? await hostApi.discoverAndLoadExtensions([], root, agentDir)
      : await hostApi.discoverAndLoadExtensions([], root);
  check(loaded.errors.length === 0, `${target} loader errors: ${JSON.stringify(loaded.errors)}`);
  const registrations = loaded.runtime.pendingProviderRegistrations.filter((entry) => entry.name === 'aio-proxy');
  check(registrations.length === 1, `${target} registered ${registrations.length} providers`);
  const registration = registrations[0]!;
  const source = target === 'pi' ? registration.extensionPath : registration.sourceId;
  check(source?.endsWith(manifestEntry), `${target} loaded ${source ?? 'no path'}`);

  const devicePresentations: unknown[] = [];
  const authPresentations: Array<{ url?: string }> = [];
  const signal = new AbortController().signal;
  const shared = {
    onPrompt: async () => '',
    onSelect: async () => undefined,
    signal,
  };
  const credential = await registration.config.oauth.login(
    target === 'pi'
      ? {
          onDeviceCode: (value: unknown) => {
            devicePresentations.push(value);
          },
          ...shared,
        }
      : {
          onAuth: (value: { url?: string }) => {
            authPresentations.push(value);
          },
          ...shared,
        },
  );
  if (target === 'pi') {
    check(devicePresentations.length === 1, 'official Pi did not use onDeviceCode');
  } else {
    check(authPresentations.length === 1, 'OMP did not use onAuth');
    check(authPresentations[0]?.url?.endsWith('#code=ABCD-EFGH'), 'OMP omitted the complete URL');
  }

  const apiKey = registration.config.oauth.getApiKey(credential);
  let models: readonly HostModel[];
  if (target === 'pi') {
    const refreshModels = registration.config.refreshModels;
    check(refreshModels !== undefined, 'official Pi registration omitted refreshModels');
    models = await refreshModels({
      credential: { type: 'oauth', ...credential },
      allowNetwork: true,
      force: true,
      signal,
      publish: async () => true,
    });
  } else {
    const fetchDynamicModels = registration.config.fetchDynamicModels;
    check(fetchDynamicModels !== undefined, 'OMP registration omitted fetchDynamicModels');
    models = await fetchDynamicModels(apiKey);
  }
  check(models.length === 1, `${target} returned ${models.length} models`);
  check(
    JSON.stringify(models[0]) ===
      JSON.stringify({
        id: 'compat-model',
        name: 'Compat Model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8_192,
        maxTokens: 2_048,
      }),
    `${target} projected the wrong model shape: ${JSON.stringify(models[0])}`,
  );

  if (scenario === 'crash') {
    const refreshToken = registration.config.oauth.refreshToken;
    check(refreshToken !== undefined, 'missing refreshToken');
    await refreshToken(credential, signal);
  }
  await seedExpiredCredential(target, hostApi, agentDir, credential);
  console.log('PROBE_OK');
}

function assertSuccessfulPair(results: readonly CommandResult[], stats: Stats, host: string): void {
  for (const result of results) {
    check(result.exitCode === 0, `${host} print mode failed:\n${result.stderr}`);
    check(`${result.stdout}\n${result.stderr}`.includes('compat-ok'), `${host} missed compat-ok`);
  }
  check(
    stats.refreshRequests >= 1 && stats.refreshRequests <= 2,
    `${host} refresh request count was ${stats.refreshRequests}`,
  );
  check(stats.rotatedPairs === 1, `${host} issued ${stats.rotatedPairs} rotated pairs`);
  check(stats.successfulInferenceCalls === 2, `${host} inference count was ${stats.successfulInferenceCalls}`);
  check(stats.anonymousCatalogCalls === 0, `${host} made an anonymous catalog request`);
  check(stats.anonymousInferenceCalls === 0, `${host} made an anonymous inference request`);
  check(stats.disallowedAuthorizationCalls === 0, `${host} used a disallowed Authorization value`);
}

async function runScenario(
  host: Host,
  installRoot: string,
  packageRoot: string,
  binary: string,
  scenario: Scenario,
): Promise<void> {
  const root = join(installRoot, scenario);
  const agentDir = join(root, 'agent');
  await mkdir(root, { recursive: true });
  const proxy = startFakeProxy(host.target);
  try {
    await installManagedPlugin(agentDir, host.target, proxy.endpoint);
    const env = isolatedEnv(root, agentDir);
    const probe = await run(
      [
        host.target === 'pi' ? 'node' : process.execPath,
        import.meta.path,
        '--probe',
        host.target,
        packageRoot,
        root,
        agentDir,
        scenario,
        host.manifestEntry,
      ],
      root,
      env,
    );
    check(
      probe.exitCode === 0 && probe.stdout.includes('PROBE_OK'),
      `${host.target}@${host.version} probe failed:\n${probe.stderr}`,
    );

    const label = `${host.target}@${host.version}`;
    if (scenario === 'concurrent') {
      const results = await Promise.all([
        run([binary, ...PRINT_ARGS], root, env),
        run([binary, ...PRINT_ARGS], root, env),
      ]);
      const afterPair = proxy.stats();
      assertSuccessfulPair(results, afterPair, label);
      proxy.rejectOldRefresh();
      const persisted = await run([binary, ...PRINT_ARGS], root, env);
      check(persisted.exitCode === 0, `${label} persisted-rotation process failed:\n${persisted.stderr}`);
      check(
        `${persisted.stdout}\n${persisted.stderr}`.includes('compat-ok'),
        `${label} persisted-rotation process missed compat-ok`,
      );
      const afterPersist = proxy.stats();
      check(
        afterPersist.refreshRequests === afterPair.refreshRequests,
        `${label} refreshed again after persisted rotation`,
      );
      check(afterPersist.oldRefreshAfterReject === 0, `${label} reused a consumed refresh token`);
      check(afterPersist.rotatedRefreshRequests === 0, `${label} refreshed an already-rotated token`);
      check(afterPersist.rotatedPairs === 1, `${label} issued ${afterPersist.rotatedPairs} rotated pairs`);
      check(
        afterPersist.successfulInferenceCalls === 3,
        `${label} inference count was ${afterPersist.successfulInferenceCalls}`,
      );
      check(afterPersist.anonymousCatalogCalls === 0, `${label} made an anonymous catalog request`);
      check(afterPersist.anonymousInferenceCalls === 0, `${label} made an anonymous inference request`);
      check(afterPersist.disallowedAuthorizationCalls === 0, `${label} used a disallowed Authorization value`);
      return;
    }

    proxy.rejectOldRefresh();
    const result = await run([binary, ...PRINT_ARGS], root, env);
    check(result.exitCode !== 0, `${label} crash-window run unexpectedly succeeded`);
    check(
      `${result.stdout}\n${result.stderr}`.includes('aio-proxy login required'),
      `${label} omitted a re-login diagnostic`,
    );
    const stats = proxy.stats();
    check(stats.successfulInferenceCalls === 0, `${label} inferred after invalid_grant`);
    check(stats.anonymousCatalogCalls === 0, `${label} made an anonymous catalog request`);
    check(stats.anonymousInferenceCalls === 0, `${label} made an anonymous inference request`);
    check(stats.disallowedAuthorizationCalls === 0, `${label} used a disallowed Authorization value`);
  } finally {
    proxy.stop();
  }
}

async function runHost(host: Host): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `aio-proxy-${host.target}-${host.version}-`));
  try {
    await writeFile(join(root, 'package.json'), '{"private":true}\n');
    // Isolated bun add otherwise inherits bnpm and cannot resolve public OMP 17.3.7.
    await writeFile(join(root, 'bunfig.toml'), '[install]\nregistry = "https://registry.npmjs.org/"\n');
    const install = await run(
      [process.execPath, 'add', '--exact', `${host.packageName}@${host.version}`],
      root,
      { ...process.env, CI: '1' },
      120_000,
    );
    check(install.exitCode === 0, `${host.packageName}@${host.version} install failed:\n${install.stderr}`);
    const packageRoot = join(root, 'node_modules', ...host.packageName.split('/'));
    const binary = join(root, 'node_modules', '.bin', host.binary);
    await runScenario(host, root, packageRoot, binary, 'concurrent');
    await runScenario(host, root, packageRoot, binary, 'crash');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--probe') {
  const [, , , target, packageRoot, root, agentDir, scenario, manifestEntry] = process.argv;
  check(target === 'pi' || target === 'omp', 'invalid probe target');
  check(scenario === 'concurrent' || scenario === 'crash', 'invalid probe scenario');
  await runProbe(target, packageRoot!, root!, agentDir!, scenario, manifestEntry!);
} else {
  for (const host of hosts) await runHost(host);
}
