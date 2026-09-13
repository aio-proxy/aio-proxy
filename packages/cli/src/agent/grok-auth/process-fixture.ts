import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentIdentityService, type AgentIdentityService, type AgentRefreshResult } from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { AGENT_CLIENT_ID } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import {
  configureGrok,
  loadGrokPolicy,
  readGrokObservation,
  withGrokInstallation,
  type GrokAuthObservation,
  type GrokDeps,
} from '../grok';
import { setGrokInstallationTestHookForTest } from '../grok/grok';
import { saveGrokToken } from './credential';
import { grokAuth } from './grok-auth';
import { createGrokTransport } from './transport';
import type { GrokAuthInput } from './types';

export type HelperGate =
  | 'before-refresh-response'
  | 'after-credential-save'
  | 'before-stdout'
  | 'after-delivery-before-release';

export type HelperChild = {
  readonly process: ReturnType<typeof Bun.spawn>;
  readonly stdout: Promise<string>;
  readonly stderr: Promise<string>;
  readonly exit: Promise<number>;
  readonly observed: Promise<GrokAuthObservation>;
  readonly afterSave: Promise<void>;
  readonly afterStdout: Promise<void>;
  readonly deliveryCommitted: Promise<void>;
  readonly beforeRename: Promise<void>;
  release(): void;
  cancelStdout(): Promise<void>;
};

export type SpawnHelperOptions = {
  readonly gate?: HelperGate;
  readonly holdAfterObservation?: boolean;
  readonly pauseBeforeReadyRename?: boolean;
  readonly pauseAfterStdout?: boolean;
  readonly failDeliveredByWrite?: boolean;
  readonly now?: number;
};

type ChildPayload = {
  readonly input: GrokAuthInput;
} & SpawnHelperOptions;

type IpcMessage = {
  readonly type: 'observed' | 'after-save' | 'after-stdout' | 'delivery-committed' | 'before-rename';
  readonly observation?: GrokAuthObservation;
};

const FIXTURE_PATH = import.meta.path;
const ADAPTER_VERSION = '0.21.0';

function writeStdoutLine(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(line, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function waitForRelease(): Promise<void> {
  return new Promise((resolve) => {
    const onMessage = (message: unknown) => {
      if (isPlainObject(message) && message['type'] === 'release') {
        process.off('message', onMessage);
        resolve();
      }
    };
    process.on('message', onMessage);
  });
}

function sendIpc(message: IpcMessage): void {
  process.send?.(message);
}

async function runChild(payload: ChildPayload): Promise<void> {
  const now = payload.now === undefined ? Date.now : () => payload.now as number;
  const stdoutGate = payload.gate === 'after-credential-save' || payload.gate === 'before-stdout';
  if (payload.gate === 'after-delivery-before-release') {
    setGrokInstallationTestHookForTest({
      afterAction: async () => {
        sendIpc({ type: 'delivery-committed' });
        await waitForRelease();
      },
    });
  } else {
    setGrokInstallationTestHookForTest({
      ...(payload.pauseBeforeReadyRename === true
        ? {
            beforeReadyCredentialRename: async () => {
              sendIpc({ type: 'before-rename' });
              await waitForRelease();
            },
          }
        : {}),
      ...(payload.failDeliveredByWrite === true ? { failDeliveredByWrite: true } : {}),
    });
  }
  try {
    await grokAuth(payload.input, {
      now,
      policy: loadGrokPolicy,
      readObservation: async (root, installationId, budget) => {
        const result = await readGrokObservation(root, installationId, budget);
        sendIpc({ type: 'observed', observation: result });
        if (payload.holdAfterObservation === true) await waitForRelease();
        return result;
      },
      transport: (marker, budget) => createGrokTransport(marker, budget, { now }),
      stdout: async (line) => {
        if (stdoutGate) {
          sendIpc({ type: 'after-save' });
          await waitForRelease();
        }
        await writeStdoutLine(line);
        if (payload.pauseAfterStdout === true) {
          sendIpc({ type: 'after-stdout' });
          await waitForRelease();
        }
      },
      stderr: (line) => {
        process.stderr.write(line);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    setGrokInstallationTestHookForTest();
  }
}

function drainStdio(stream: ReadableStream<Uint8Array> | undefined): {
  readonly text: Promise<string>;
  readonly cancel: () => Promise<void>;
} {
  if (stream === undefined) return { text: Promise.resolve(''), cancel: async () => {} };
  const reader = stream.getReader();
  const text = (async () => {
    const decoder = new TextDecoder();
    let output = '';
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) return output + decoder.decode();
        output += decoder.decode(part.value, { stream: true });
      }
    } catch {
      return output;
    }
  })();
  return {
    text,
    cancel: async () => {
      await reader.cancel().catch(() => undefined);
    },
  };
}

export function spawnHelperForTest(input: GrokAuthInput, options?: SpawnHelperOptions): HelperChild {
  const observed = Promise.withResolvers<GrokAuthObservation>();
  const afterSave = Promise.withResolvers<void>();
  const afterStdout = Promise.withResolvers<void>();
  const deliveryCommitted = Promise.withResolvers<void>();
  const beforeRename = Promise.withResolvers<void>();
  const payload: ChildPayload = { input, ...options };
  const processHandle = Bun.spawn([process.execPath, FIXTURE_PATH, JSON.stringify(payload)], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    serialization: 'json',
    ipc(message) {
      if (!isPlainObject(message) || typeof message['type'] !== 'string') return;
      if (message['type'] === 'observed') {
        const observation = isPlainObject(message['observation'])
          ? (message['observation'] as GrokAuthObservation)
          : {};
        observed.resolve(observation);
      }
      if (message['type'] === 'after-save') afterSave.resolve();
      if (message['type'] === 'after-stdout') afterStdout.resolve();
      if (message['type'] === 'delivery-committed') deliveryCommitted.resolve();
      if (message['type'] === 'before-rename') beforeRename.resolve();
    },
  });
  const stdout = drainStdio(processHandle.stdout);
  const stderr = drainStdio(processHandle.stderr);
  return {
    process: processHandle,
    stdout: stdout.text,
    stderr: stderr.text,
    exit: processHandle.exited,
    observed: observed.promise,
    afterSave: afterSave.promise,
    afterStdout: afterStdout.promise,
    deliveryCommitted: deliveryCommitted.promise,
    beforeRename: beforeRename.promise,
    release() {
      processHandle.send({ type: 'release' });
    },
    cancelStdout: stdout.cancel,
  };
}

async function readRequestBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

function randomDeviceCode(): string {
  return (crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')).slice(0, 43);
}

function countingIdentity(inner: AgentIdentityService): {
  readonly identity: AgentIdentityService;
  readonly stats: { rotationCount: number; refreshRequestCount: number };
} {
  const stats = { rotationCount: 0, refreshRequestCount: 0 };
  let lastRefreshToken: string | undefined;
  return {
    stats,
    identity: {
      ...inner,
      refreshCredential: (input): AgentRefreshResult => {
        const result = inner.refreshCredential(input);
        if (result.status === 'success' && result.refreshToken !== lastRefreshToken) {
          stats.rotationCount += 1;
          lastRefreshToken = result.refreshToken;
        }
        return result;
      },
    },
  };
}

type RefreshGate = {
  hold: boolean;
  dropAfterRotate: boolean;
  entered: PromiseWithResolvers<void>;
  release: PromiseWithResolvers<void>;
};

type AuthCtx = {
  readonly identity: AgentIdentityService;
  readonly stats: { refreshRequestCount: number };
  readonly gate: RefreshGate;
  readonly devices: Map<string, { readonly installationId: string; readonly adapterVersion: string }>;
  readonly port: () => number;
};

function sendToken(
  res: ServerResponse,
  issued: { readonly accessToken: string; readonly refreshToken: string; readonly expiresIn: number },
): void {
  sendJson(res, 200, {
    token_type: 'Bearer',
    access_token: issued.accessToken,
    refresh_token: issued.refreshToken,
    expires_in: issued.expiresIn,
  });
}

async function listenLoopback(
  identity: AgentIdentityService,
  stats: { refreshRequestCount: number },
  gate: RefreshGate,
): Promise<{ readonly endpoint: string; readonly close: () => Promise<void> }> {
  const devices = new Map<string, { readonly installationId: string; readonly adapterVersion: string }>();
  let port = 0;
  const server = createServer((req, res) => {
    void handleAuthRequest(req, res, { identity, stats, gate, devices, port: () => port });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handleAuthRequest(req: IncomingMessage, res: ServerResponse, ctx: AuthCtx): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'POST') return sendJson(res, 404, { error: 'invalid_request' });
    const form = await readRequestBody(req);
    if (url.pathname === '/oauth/device/code') {
      const deviceCode = randomDeviceCode();
      ctx.devices.set(deviceCode, {
        installationId: form.get('installation_id') ?? '',
        adapterVersion: form.get('adapter_version') ?? ADAPTER_VERSION,
      });
      const origin = `http://127.0.0.1:${ctx.port()}`;
      sendJson(res, 200, {
        device_code: deviceCode,
        user_code: 'ABCD-EFGH',
        verification_uri: `${origin}/dashboard/agents/authorize`,
        verification_uri_complete: `${origin}/dashboard/agents/authorize#code=ABCD-EFGH`,
        expires_in: 600,
        interval: 5,
      });
      return;
    }
    if (url.pathname !== '/oauth/token') return sendJson(res, 404, { error: 'invalid_request' });
    await handleToken(req, res, form, ctx);
  } catch {
    if (!res.headersSent) sendJson(res, 500, { error: 'invalid_request' });
  }
}

async function handleToken(
  req: IncomingMessage,
  res: ServerResponse,
  form: URLSearchParams,
  ctx: AuthCtx,
): Promise<void> {
  const grant = form.get('grant_type');
  if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
    const pending = ctx.devices.get(form.get('device_code') ?? '');
    if (pending === undefined) return sendJson(res, 400, { error: 'invalid_grant' });
    sendToken(
      res,
      ctx.identity.issueCredential({
        installationId: pending.installationId,
        target: 'grok',
        adapterVersion: pending.adapterVersion,
      }),
    );
    return;
  }
  if (grant !== 'refresh_token') return sendJson(res, 400, { error: 'invalid_request' });
  ctx.stats.refreshRequestCount += 1;
  const result = ctx.identity.refreshCredential({
    clientId: AGENT_CLIENT_ID.grok,
    refreshToken: form.get('refresh_token') ?? '',
  });
  if (ctx.gate.hold) {
    ctx.gate.entered.resolve();
    await ctx.gate.release.promise;
  }
  if (ctx.gate.dropAfterRotate) {
    ctx.gate.dropAfterRotate = false;
    req.socket.destroy();
    return;
  }
  if (result.status !== 'success') return sendJson(res, 400, { error: 'invalid_grant' });
  sendToken(res, result);
}

async function seedReadyCredential(
  root: string,
  identity: AgentIdentityService,
  deps: GrokDeps,
  endpoint: string,
  now: number,
) {
  const configured = await configureGrok(
    { root, endpoint, executable: '/opt/bin/aio-proxy', adapterVersion: ADAPTER_VERSION },
    deps,
  );
  const issued = identity.issueCredential({
    installationId: configured.marker.installationId,
    target: 'grok',
    adapterVersion: ADAPTER_VERSION,
  });
  await withGrokInstallation(
    {
      root,
      installationId: configured.marker.installationId,
      adapterVersion: ADAPTER_VERSION,
      budget: { deadline: Date.now() + 15_000, signal: AbortSignal.timeout(15_000) },
      policy: deps.policy,
    },
    (context) =>
      saveGrokToken(
        context,
        undefined,
        {
          token_type: 'Bearer',
          access_token: issued.accessToken,
          refresh_token: issued.refreshToken,
          expires_in: issued.expiresIn,
        },
        now,
      ),
  );
  return { configured, issued };
}

export async function createGrokProcessHarness() {
  const root = await mkdtemp(join(tmpdir(), 'aio-grok-process-'));
  const dbHome = await mkdtemp(join(tmpdir(), 'aio-grok-identity-'));
  const db = openDb({ home: dbHome });
  let clock = Date.now();
  const { identity, stats } = countingIdentity(createAgentIdentityService(db.sqlite, { now: () => clock }));
  const gate: RefreshGate = {
    hold: false,
    dropAfterRotate: false,
    entered: Promise.withResolvers(),
    release: Promise.withResolvers(),
  };
  const children: HelperChild[] = [];
  const loopback = await listenLoopback(identity, stats, gate);
  const deps: GrokDeps = {
    now: () => clock,
    randomUUID: () => crypto.randomUUID(),
    policy: async () => ({ env: {}, sources: [] }),
    revoke: async (_endpoint, installationId) => identity.revokeInstallation(installationId),
  };
  const seeded = await seedReadyCredential(root, identity, deps, loopback.endpoint, clock);
  const input: GrokAuthInput = {
    root,
    installationId: seeded.configured.marker.installationId,
    adapterVersion: ADAPTER_VERSION,
    expired: false,
  };
  return {
    root,
    input,
    deps,
    identity,
    issued: seeded.issued,
    configured: seeded.configured,
    endpoint: loopback.endpoint,
    get rotationCount() {
      return stats.rotationCount;
    },
    get refreshRequestCount() {
      return stats.refreshRequestCount;
    },
    setNow(value: number) {
      clock = value;
    },
    holdRefresh() {
      gate.hold = true;
      gate.entered = Promise.withResolvers();
      gate.release = Promise.withResolvers();
    },
    get refreshEntered() {
      return gate.entered.promise;
    },
    releaseRefresh() {
      gate.hold = false;
      gate.release.resolve();
    },
    dropNextRefreshResponse() {
      gate.dropAfterRotate = true;
    },
    spawnHelperForTest(next: GrokAuthInput, options?: SpawnHelperOptions): HelperChild {
      const child = spawnHelperForTest(next, options);
      children.push(child);
      return child;
    },
    async cleanup() {
      for (const child of children) {
        try {
          child.process.kill(9);
        } catch {}
        await child.exit.catch(() => undefined);
      }
      children.length = 0;
      await loopback.close();
      db.close();
      await Promise.all([rm(root, { recursive: true, force: true }), rm(dbHome, { recursive: true, force: true })]);
    },
  };
}

if (import.meta.main) {
  const raw = Bun.argv[2];
  if (raw === undefined) throw new Error('process-fixture requires argv JSON');
  await runChild(JSON.parse(raw) as ChildPayload);
}
