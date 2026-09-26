import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentIdentityService } from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import type { AgentLocalState, AgentOperationResult, AgentOperationState } from '@aio-proxy/types';

import { createServer } from '#server-test-lifecycle';

import { loopbackServer } from '../dashboard-auth/test-support';
import { AgentOperationError, type AgentHostPort, type AgentOperationEvents } from './host-port';

const INSTALLATION = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
const LOCAL_ORIGIN = 'http://127.0.0.1:9317';
const remoteServer = { requestIP: () => ({ address: '203.0.113.10' }) };
const sameOrigin = { origin: LOCAL_ORIGIN, 'sec-fetch-site': 'same-origin' };
const post = (value?: unknown, headers: Record<string, string> = sameOrigin): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  ...(value === undefined ? {} : { body: JSON.stringify(value) }),
});
const form = (value: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(value),
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const localState = (overrides: Partial<AgentLocalState> = {}): AgentLocalState => ({
  target: 'opencode',
  host: { detected: true, version: '1.20.0', support: 'supported' },
  status: 'configured',
  installationId: INSTALLATION,
  ...overrides,
});

type Deferred = { readonly promise: Promise<void>; readonly resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function fixture(options: { readonly host?: Partial<AgentHostPort> | false; readonly password?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-dashboard-'));
  const identityDb = openDb({ home: join(home, 'identity') });
  const agentIdentity = createAgentIdentityService(identityDb.sqlite);
  const calls: string[] = [];
  const host: AgentHostPort = {
    inspect: async () => [localState()],
    configure: async (target) => {
      calls.push(`configure:${target}`);
      return { target, status: 'installed', installationId: INSTALLATION };
    },
    remove: async (target) => ({ target, status: 'removed' }),
    codexPlan: async () => {
      throw new AgentOperationError('recovery_required');
    },
    restoreCodexMigration: async () => ({ target: 'codex', status: 'unchanged' }),
    ...(options.host === false ? {} : options.host),
  };
  const app = await createServer({
    config: {
      server: {
        host: '127.0.0.1',
        port: 9_317,
        ...(options.password === undefined ? {} : { password: options.password }),
      },
      providers: {},
    },
    dbHome: join(home, 'server'),
    host: '127.0.0.1',
    port: 9_317,
    ...(options.host === false ? {} : { agentHost: host }),
    __test: { agentIdentity },
  });
  cleanups.push(() => {
    (app as typeof app & { close: () => void }).close();
    identityDb.close();
    rmSync(home, { recursive: true, force: true });
  });
  const request = (path: string, init?: RequestInit, env: object = loopbackServer) =>
    app.request(`${LOCAL_ORIGIN}/dashboard/api/agents${path}`, init, env);
  const until = async (operationId: string, status: AgentOperationState['status']): Promise<AgentOperationState> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const state = (await (await request(`/operations/${operationId}`)).json()) as AgentOperationState;
      if (state.status === status) return state;
      await Bun.sleep(5);
    }
    throw new Error(`operation never reached ${status}`);
  };
  const deviceCode = async (): Promise<string> => {
    const response = await app.request(
      '/oauth/device/code',
      form({
        client_id: 'aio-proxy-codex',
        agent: 'codex',
        installation_id: INSTALLATION,
        adapter_version: '1.2.3',
      }),
      loopbackServer,
    );
    return ((await response.json()) as { user_code: string }).user_code;
  };
  const login = async (env: object): Promise<string> => {
    const response = await app.request(
      `${LOCAL_ORIGIN}/dashboard/api/auth/login`,
      post({ password: options.password }),
      env,
    );
    return ((await response.json()) as { token: string }).token;
  };
  return { app, request, until, calls, deviceCode, login };
}

test('the snapshot reports whether this browser may write local Agent files', async () => {
  const local = await fixture();
  const available = await (await local.request('')).json();
  expect(available).toMatchObject({ localSetup: 'available', deviceAuthorization: 'available', installations: [] });
  expect(available.local).toEqual([localState()]);

  const secured = await fixture({ password: 'correct horse battery staple' });
  const token = await secured.login(remoteServer);
  const auth = { authorization: `Bearer ${token}` };
  const remote = await (await secured.request('', { headers: auth }, remoteServer)).json();
  expect(remote.localSetup).toBe('remote_request');
  expect(remote.local).toBeUndefined();
  const write = await secured.request(
    '/operations',
    post({ kind: 'configure', target: 'opencode' }, { ...sameOrigin, ...auth }),
    remoteServer,
  );
  expect(write.status).toBe(404);
  expect(secured.calls).toEqual([]);

  const without = await fixture({ host: false });
  const unavailable = await (await without.request('')).json();
  expect(unavailable.localSetup).toBe('unavailable');
  expect((await without.request('/operations', post({ kind: 'configure', target: 'opencode' }))).status).toBe(404);
});

test('remote and cross-origin requests cannot start operations', async () => {
  const f = await fixture();
  const body = { kind: 'configure', target: 'opencode' };
  expect((await f.request('/operations', post(body), remoteServer)).status).toBe(404);
  expect(
    (await f.request('/operations', post(body, { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' })))
      .status,
  ).toBe(403);
  expect((await f.request('/codex/plan', undefined, remoteServer)).status).toBe(404);
  expect(f.calls).toEqual([]);
});

test('configure runs as a polled operation and refuses a concurrent one for the same target', async () => {
  const gate = deferred();
  const f = await fixture({
    host: {
      configure: async (target): Promise<AgentOperationResult> => {
        await gate.promise;
        return { target, status: 'installed', installationId: INSTALLATION };
      },
    },
  });
  const started = await f.request('/operations', post({ kind: 'configure', target: 'opencode' }));
  expect(started.status).toBe(202);
  const state = (await started.json()) as AgentOperationState;
  expect(state.status).toBe('running');
  expect((await f.request('/operations', post({ kind: 'remove', target: 'opencode' }))).status).toBe(409);
  expect((await f.request('/operations', post({ kind: 'configure', target: 'pi' }))).status).toBe(202);
  gate.resolve();
  const done = await f.until(state.operationId, 'succeeded');
  expect(done).toMatchObject({ status: 'succeeded', result: { target: 'opencode', status: 'installed' } });
});

const codexOperation = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.request(
    '/operations',
    post({
      kind: 'configure',
      target: 'codex',
      codex: { providerId: 'aio-proxy', auth: { mode: 'command' }, migrateFrom: [], planToken: 'plan' },
    }),
  );

const codexHost = (approved: Deferred, codes: { userCode?: string }, deviceCode: () => Promise<string>) => ({
  configure: async (_target: unknown, _codex: unknown, events: AgentOperationEvents): Promise<AgentOperationResult> => {
    codes.userCode = await deviceCode();
    events.onDevice({ userCode: codes.userCode });
    await Promise.race([
      approved.promise,
      new Promise<never>((_, reject) => {
        events.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    ]);
    return { target: 'codex', status: 'configured', installationId: INSTALLATION, authMode: 'command' };
  },
});

test('a Codex command-mode configure waits for an explicit dashboard approval', async () => {
  const approved = deferred();
  const codes: { userCode?: string } = {};
  let deviceCode: () => Promise<string> = async () => '';
  const f = await fixture({ host: codexHost(approved, codes, () => deviceCode()) });
  deviceCode = f.deviceCode;
  const { operationId } = (await (await codexOperation(f)).json()) as AgentOperationState;
  const waiting = await f.until(operationId, 'awaiting_approval');
  expect(waiting).toMatchObject({ installationId: INSTALLATION, userCode: codes.userCode });

  expect((await f.request(`/operations/${operationId}/approve`, post(), remoteServer)).status).toBe(404);
  const resumed = await f.request(`/operations/${operationId}/approve`, post());
  expect(((await resumed.json()) as AgentOperationState).status).toBe('running');
  approved.resolve();
  const done = await f.until(operationId, 'succeeded');
  expect(JSON.stringify(done)).not.toContain('aio_agent_');
});

test.each([
  ['deny', 'authorization_denied'],
  ['cancel', 'cancelled'],
] as const)('%s while awaiting approval stops the operation', async (action, code) => {
  const codes: { userCode?: string } = {};
  let deviceCode: () => Promise<string> = async () => '';
  const f = await fixture({ host: codexHost(deferred(), codes, () => deviceCode()) });
  deviceCode = f.deviceCode;
  const { operationId } = (await (await codexOperation(f)).json()) as AgentOperationState;
  await f.until(operationId, 'awaiting_approval');
  expect((await f.request(`/operations/${operationId}/${action}`, post())).status).toBe(200);
  expect(await f.until(operationId, 'failed')).toMatchObject({ error: code });
  const resolved = await f.app.request(
    `${LOCAL_ORIGIN}/dashboard/api/agent-authorizations/resolve`,
    post({ userCode: codes.userCode }),
    loopbackServer,
  );
  expect(await resolved.json()).toEqual({ status: 'denied' });
});

test('classified host failures surface their code; codex plan maps errors to 409', async () => {
  const f = await fixture({
    host: {
      remove: async () => {
        throw new AgentOperationError('locked');
      },
    },
  });
  const { operationId } = (await (
    await f.request('/operations', post({ kind: 'remove', target: 'grok' }))
  ).json()) as AgentOperationState;
  expect(await f.until(operationId, 'failed')).toMatchObject({ error: 'locked' });
  const plan = await f.request('/codex/plan');
  expect(plan.status).toBe(409);
  expect(await plan.json()).toEqual({ error: 'recovery_required' });
});

test('pending login lookup only answers for installations configured on this machine', async () => {
  const f = await fixture();
  expect((await f.request('/installations/7d1e3b1e-7a41-4c1e-9d5e-7e7f5b3c2a10/pending')).status).toBe(404);
  const empty = await (await f.request(`/installations/${INSTALLATION}/pending`)).json();
  expect(empty).toEqual({ authorization: null });
  await f.app.request(
    '/oauth/device/code',
    form({
      client_id: 'aio-proxy-opencode',
      agent: 'opencode',
      installation_id: INSTALLATION,
      adapter_version: '1.2.3',
    }),
    loopbackServer,
  );
  const pending = await (await f.request(`/installations/${INSTALLATION}/pending`)).json();
  expect(pending.authorization).toMatchObject({ status: 'pending', target: 'opencode', installationId: INSTALLATION });
});
