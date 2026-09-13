import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentTokenResponse } from '@aio-proxy/types';

import { configureGrok, withGrokInstallation, type GrokContext, type GrokMarker } from '../../grok';
import { grokFixture } from '../../grok/test-fixture';
import { createGrokTransport } from '../transport';
import type { GrokCredential } from '../types';
import { beginGrokRefresh, grokRefreshRecoverable, parseGrokCredential, saveGrokToken } from './credential';

const MARKER = {
  format: 1,
  managedBy: 'aio-proxy',
  agent: 'grok',
  installationId: '11111111-1111-4111-8111-111111111111',
  adapterVersion: '0.21.0',
  endpoint: 'http://127.0.0.1:9317',
} as const satisfies GrokMarker;

const TOKEN = {
  token_type: 'Bearer',
  access_token: `aio_agent_at_v1_${'a'.repeat(43)}`,
  refresh_token: `aio_agent_rt_v1_${'b'.repeat(43)}`,
  expires_in: 900,
} as const satisfies AgentTokenResponse;

const READY: GrokCredential = {
  format: 1,
  agent: 'grok',
  installationId: MARKER.installationId,
  endpoint: MARKER.endpoint,
  revision: 2,
  accessToken: 'fake-at',
  refreshToken: 'fake-rt',
  accessExpiresAt: 901_000,
  deliveredBy: '22222222-2222-4222-8222-222222222222',
  status: 'ready',
};

const budget = () => ({ deadline: Date.now() + 5_000, signal: AbortSignal.timeout(5_000) });

const context = (overrides: Partial<GrokContext> = {}): GrokContext => {
  const written: unknown[] = [];
  return {
    marker: MARKER,
    root: '/tmp',
    budget: budget(),
    assertOwnership: async () => {},
    lockOwner: '22222222-2222-4222-8222-222222222222',
    assertRoutingSafe: async () => {},
    readCredential: async () => written.at(-1),
    writeCredential: async (value) => {
      written.push(value);
    },
    clearCredential: async () => {},
    ...overrides,
  };
};

test('refresh replay is bounded by the first attempt, not each restart', () => {
  const state: GrokCredential = {
    format: 1,
    agent: 'grok',
    installationId: '11111111-1111-4111-8111-111111111111',
    endpoint: 'http://127.0.0.1:9317',
    revision: 2,
    accessToken: 'fake-at',
    refreshToken: 'fake-rt',
    accessExpiresAt: 901_000,
    deliveredBy: '22222222-2222-4222-8222-222222222222',
    status: 'refreshing',
    refreshStartedAt: 1_000,
  };
  expect(grokRefreshRecoverable(state, 30_999)).toBe(true);
  expect(grokRefreshRecoverable(state, 31_000)).toBe(false);
  expect(grokRefreshRecoverable(state, 999)).toBe(false);
});

test('client replay window stays inside the core identity 30 second case', async () => {
  const coreTest = await Bun.file(
    new URL('../../../../../core/src/agent-identity/agent-identity.test.ts', import.meta.url),
  ).text();
  expect(coreTest).toContain('replays one rotation result for 30 seconds without creating another token');
  expect(coreTest).toContain('f.setNow(30_999)');
  expect(grokRefreshRecoverable({ ...READY, status: 'refreshing', refreshStartedAt: 1_000 }, 30_999)).toBe(true);
});

test('saveGrokToken writes durable state before returning the new token', async () => {
  const events: string[] = [];
  let stored: unknown;
  const saved = await saveGrokToken(
    context({
      writeCredential: async (value) => {
        events.push('write');
        stored = value;
      },
    }),
    READY,
    TOKEN,
    1_000,
  );
  events.push('return');
  expect(events).toEqual(['write', 'return']);
  expect(stored).toEqual(saved);
  expect(saved).toEqual({
    format: 1,
    agent: 'grok',
    installationId: MARKER.installationId,
    endpoint: MARKER.endpoint,
    revision: 3,
    status: 'ready',
    accessToken: TOKEN.access_token,
    refreshToken: TOKEN.refresh_token,
    accessExpiresAt: 901_000,
  });
  expect('deliveredBy' in saved).toBe(false);
  expect('refreshStartedAt' in saved).toBe(false);
});

test('saveGrokToken does not return a token when storage write fails', async () => {
  let resolved: GrokCredential | undefined;
  await expect(
    saveGrokToken(
      context({
        writeCredential: async () => {
          throw new Error('disk full');
        },
      }),
      READY,
      TOKEN,
      1_000,
    ).then((value) => {
      resolved = value;
      return value;
    }),
  ).rejects.toThrow('disk full');
  expect(resolved).toBeUndefined();
});

test('saveGrokToken persists through GrokContext before the caller observes the token', async () => {
  const f = await grokFixture();
  try {
    const installed = await configureGrok(f.input, f.deps);
    await withGrokInstallation(
      {
        root: f.root,
        installationId: installed.marker.installationId,
        adapterVersion: f.input.adapterVersion,
        budget: budget(),
        policy: f.deps.policy,
      },
      async (installation) => {
        const saved = await saveGrokToken(installation, undefined, TOKEN, 1_000);
        expect(await installation.readCredential()).toEqual(saved);
        expect(saved.revision).toBe(1);
        expect('deliveredBy' in saved).toBe(false);
        const text = await readFile(join(f.root, 'aio-proxy', 'credential.json'), 'utf8');
        expect(JSON.parse(text)).toEqual(saved);
      },
    );
  } finally {
    await f.cleanup();
  }
});

test('beginGrokRefresh keeps tokens and the first startedAt', async () => {
  const written: unknown[] = [];
  const grok = context({
    writeCredential: async (value) => {
      written.push(value);
    },
  });
  const first = await beginGrokRefresh(grok, READY, 1_000);
  expect(first).toEqual({
    format: 1,
    agent: 'grok',
    installationId: READY.installationId,
    endpoint: READY.endpoint,
    revision: 2,
    accessToken: 'fake-at',
    refreshToken: 'fake-rt',
    accessExpiresAt: 901_000,
    deliveredBy: READY.deliveredBy,
    status: 'refreshing',
    refreshStartedAt: 1_000,
  });
  const again = await beginGrokRefresh(grok, first, 5_000);
  expect(again.refreshStartedAt).toBe(1_000);
  expect(again).toEqual(first);
  expect(written).toEqual([first, again]);
});

test('parseGrokCredential rejects damage, unknown format, and marker mismatch', () => {
  expect(parseGrokCredential(READY, MARKER)).toEqual(READY);
  expect(() => parseGrokCredential({ ...READY, format: 2 }, MARKER)).toThrow(/invalid/);
  expect(() => parseGrokCredential({ ...READY, extra: true }, MARKER)).toThrow(/invalid/);
  expect(() => parseGrokCredential({ ...READY, accessToken: '' }, MARKER)).toThrow(/invalid/);
  expect(() => parseGrokCredential({ ...READY, refreshStartedAt: 1_000 }, MARKER)).toThrow(/invalid/);
  expect(() => parseGrokCredential({ ...READY, revision: -1 }, MARKER)).toThrow(/invalid/);
  expect(() => parseGrokCredential({ ...READY, revision: 1.5 }, MARKER)).toThrow(/invalid/);
  expect(() => parseGrokCredential({ ...READY, accessExpiresAt: Number.POSITIVE_INFINITY }, MARKER)).toThrow(/invalid/);
  expect(() =>
    parseGrokCredential({ ...READY, installationId: '33333333-3333-4333-8333-333333333333' }, MARKER),
  ).toThrow(/mismatch/);
  expect(() => parseGrokCredential({ ...READY, endpoint: 'http://127.0.0.1:9318' }, MARKER)).toThrow(/mismatch/);
  expect(() => parseGrokCredential(undefined, MARKER)).toThrow(/invalid/);
  const needsLogin = parseGrokCredential(
    {
      format: 1,
      agent: 'grok',
      installationId: MARKER.installationId,
      endpoint: MARKER.endpoint,
      revision: 2,
      status: 'needs_login',
      accessToken: '',
      refreshToken: '',
      accessExpiresAt: 0,
    },
    MARKER,
  );
  expect(needsLogin.status).toBe('needs_login');
  expect(needsLogin.refreshToken).toBe('');
  expect('deliveredBy' in needsLogin).toBe(false);
});

test('token binding mismatch never starts a network request', async () => {
  let fetches = 0;
  const fetch: typeof globalThis.fetch = async () => {
    fetches += 1;
    return new Response('no');
  };
  createGrokTransport(MARKER, budget(), { fetch });
  expect(() =>
    parseGrokCredential({ ...READY, installationId: '33333333-3333-4333-8333-333333333333' }, MARKER),
  ).toThrow(/mismatch/);
  expect(fetches).toBe(0);
  expect(() => parseGrokCredential({ format: 2, agent: 'grok', status: 'ready' }, MARKER)).toThrow(/invalid/);
  expect(fetches).toBe(0);
});

test('refreshing credentials keep the original refresh token', () => {
  const inflight: GrokCredential = { ...READY, status: 'refreshing', refreshStartedAt: 1_000 };
  expect(parseGrokCredential(inflight, MARKER).refreshToken).toBe('fake-rt');
  expect(grokRefreshRecoverable(READY, 1_000)).toBe(false);
});
