import type { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_ACCESS_TOKEN_PREFIX, AGENT_REFRESH_TOKEN_PREFIX } from '@aio-proxy/types';

import { openDb } from '../db';
import {
  AgentInstallationTargetMismatchError,
  createAgentIdentityService,
  type AgentIdentityService,
  type AgentRefreshResult,
  type IssuedAgentCredential,
} from './agent-identity';
import { hashAgentToken } from './tokens';

const INPUT = {
  installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  target: 'opencode',
  adapterVersion: '1.2.3',
} as const;

const roots: string[] = [];
const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(input: { readonly sqlite?: Database; readonly now: number }) {
  let timestamp = input.now;
  let sequence = 0;
  let sqlite = input.sqlite;
  let close = () => {};
  if (sqlite === undefined) {
    const home = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-identity-'));
    roots.push(home);
    const handle = openDb({ home });
    sqlite = handle.sqlite;
    close = handle.close;
    closes.push(close);
  }
  const service: AgentIdentityService = createAgentIdentityService(sqlite, {
    now: () => timestamp,
    randomBytes: (size) => Buffer.alloc(size, ++sequence),
    randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
  });
  return {
    sqlite,
    service,
    close,
    setNow: (value: number) => {
      timestamp = value;
    },
    dump: () =>
      JSON.stringify({
        access: sqlite.query('SELECT * FROM agent_access_token').all(),
        refresh: sqlite.query('SELECT * FROM agent_refresh_token').all(),
      }),
  };
}

function expectRefreshSuccess(result: AgentRefreshResult): IssuedAgentCredential {
  expect(result.status).toBe('success');
  if (result.status !== 'success') throw new Error(`expected refresh success, got ${result.reason}`);
  return result;
}

test('stores only hashes while an issued access token survives service restart', () => {
  const first = fixture({ now: 1_000 });
  const issued = first.service.issueCredential(INPUT);
  expect(first.dump()).not.toContain(issued.accessToken);
  expect(first.dump()).not.toContain(issued.refreshToken);
  const restarted = fixture({ sqlite: first.sqlite, now: 2_000 });
  expect(restarted.service.authenticateAccessToken(issued.accessToken)).toMatchObject({ status: 'valid' });
});

test('replays one rotation result for 30 seconds without creating another token', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  const first = f.service.refreshCredential({ clientId: 'aio-proxy-opencode', refreshToken: issued.refreshToken });
  f.setNow(30_999);
  const replay = f.service.refreshCredential({ clientId: 'aio-proxy-opencode', refreshToken: issued.refreshToken });
  expect(replay).toEqual(first);
});

test('rotation replay keeps its full window past the old refresh expiry', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  f.setNow(issued.refreshExpiresAt - 1);
  const first = f.service.refreshCredential({
    clientId: 'aio-proxy-opencode',
    refreshToken: issued.refreshToken,
  });
  f.setNow(issued.refreshExpiresAt + 29_998);
  expect(
    f.service.refreshCredential({
      clientId: 'aio-proxy-opencode',
      refreshToken: issued.refreshToken,
    }),
  ).toEqual(first);
});

test('successful rotation immediately replaces the prior family access token', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  const rotated = expectRefreshSuccess(
    f.service.refreshCredential({
      clientId: 'aio-proxy-opencode',
      refreshToken: issued.refreshToken,
    }),
  );
  expect(f.service.authenticateAccessToken(issued.accessToken).status).toBe('invalid');
  expect(f.service.authenticateAccessToken(rotated.accessToken).status).toBe('valid');
});

test('replay never discloses a rotated pair to a mismatched client', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  expectRefreshSuccess(
    f.service.refreshCredential({
      clientId: 'aio-proxy-opencode',
      refreshToken: issued.refreshToken,
    }),
  );
  expect(f.service.refreshCredential({ clientId: 'aio-proxy-pi', refreshToken: issued.refreshToken })).toEqual({
    status: 'invalid_grant',
    reason: 'client_mismatch',
    familyRevoked: false,
  });
});

test('restart inside replay window returns invalid_grant without revoking the family', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  const rotated = expectRefreshSuccess(
    f.service.refreshCredential({
      clientId: 'aio-proxy-opencode',
      refreshToken: issued.refreshToken,
    }),
  );
  const restarted = fixture({ sqlite: f.sqlite, now: 11_000 });
  expect(
    restarted.service.refreshCredential({
      clientId: 'aio-proxy-opencode',
      refreshToken: issued.refreshToken,
    }),
  ).toEqual({ status: 'invalid_grant', reason: 'replay_lost', familyRevoked: false });
  expect(restarted.service.authenticateAccessToken(rotated.accessToken).status).toBe('valid');
});

test('reuse after 30 seconds revokes the entire family', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  const rotated = expectRefreshSuccess(
    f.service.refreshCredential({
      clientId: 'aio-proxy-opencode',
      refreshToken: issued.refreshToken,
    }),
  );
  f.setNow(31_001);
  expect(
    f.service.refreshCredential({
      clientId: 'aio-proxy-opencode',
      refreshToken: issued.refreshToken,
    }),
  ).toEqual({ status: 'invalid_grant', reason: 'reuse', familyRevoked: true });
  expect(f.service.authenticateAccessToken(rotated.accessToken).status).toBe('invalid');
});

test.each([
  ['access expiry', 'expire', 'expired'],
  ['explicit revoke', 'revoke', 'invalid'],
] as const)('%s removes access from the hot path', (_name, action, status) => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  if (action === 'revoke') f.service.revokeInstallation(INPUT.installationId);
  else f.setNow(901_000);
  expect(f.service.authenticateAccessToken(issued.accessToken).status).toBe(status);
});

test('refresh slides expiry to now plus 90 days and rejects a target/client mismatch', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  expect(f.service.refreshCredential({ clientId: 'aio-proxy-pi', refreshToken: issued.refreshToken })).toEqual({
    status: 'invalid_grant',
    reason: 'client_mismatch',
    familyRevoked: false,
  });
  f.setNow(5_000);
  const rotated = expectRefreshSuccess(
    f.service.refreshCredential({
      clientId: 'aio-proxy-opencode',
      refreshToken: issued.refreshToken,
    }),
  );
  expect(rotated.refreshExpiresAt).toBe(5_000 + 90 * 24 * 60 * 60_000);
});

test('relogin replaces the old family and revoke is idempotent for missing or terminal installations', () => {
  const f = fixture({ now: 1_000 });
  const first = f.service.issueCredential(INPUT);
  f.setNow(2_000);
  const second = f.service.issueCredential({ ...INPUT, adapterVersion: '1.2.4' });
  expect(f.service.authenticateAccessToken(first.accessToken).status).toBe('invalid');
  expect(f.service.authenticateAccessToken(second.accessToken).status).toBe('valid');
  expect(f.service.revokeInstallation(INPUT.installationId)).toBe('revoked');
  expect(f.service.revokeInstallation(INPUT.installationId)).toBe('revoked');
  expect(f.service.revokeInstallation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe('missing');
});

test('cross-target relogin leaves the original hot grant and refresh family valid', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  expect(() => f.service.issueCredential({ ...INPUT, target: 'pi' })).toThrow(AgentInstallationTargetMismatchError);
  expect(f.service.authenticateAccessToken(issued.accessToken)).toMatchObject({
    status: 'valid',
    grant: { target: 'opencode' },
  });
  expect(
    f.service.refreshCredential({
      clientId: 'aio-proxy-opencode',
      refreshToken: issued.refreshToken,
    }).status,
  ).toBe('success');
  expect(f.service.listInstallations()).toEqual([
    expect.objectContaining({ installationId: INPUT.installationId, target: 'opencode' }),
  ]);
});

test('cleanup retains consumed refresh evidence through its expiry and later removes the terminal family', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  expectRefreshSuccess(
    f.service.refreshCredential({
      clientId: 'aio-proxy-opencode',
      refreshToken: issued.refreshToken,
    }),
  );
  const oldHash = hashAgentToken(issued.refreshToken);
  f.setNow(issued.refreshExpiresAt - 1);
  f.service.issueCredential({
    installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    target: 'pi',
    adapterVersion: '1.2.3',
  });
  expect(f.sqlite.query('SELECT consumed_at FROM agent_refresh_token WHERE token_hash = ?').get(oldHash)).toMatchObject(
    {
      consumed_at: 1_000,
    },
  );
  expect(
    f.sqlite
      .query('SELECT COUNT(*) AS count FROM agent_access_token WHERE expires_at <= ?')
      .get(issued.refreshExpiresAt - 1),
  ).toEqual({ count: 0 });

  f.setNow(issued.refreshExpiresAt + 90 * 24 * 60 * 60_000 + 1);
  f.service.issueCredential({
    installationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    target: 'omp',
    adapterVersion: '1.2.3',
  });
  expect(f.sqlite.query('SELECT * FROM agent_refresh_token WHERE token_hash = ?').get(oldHash)).toBeNull();
});

test('issues a credential when production defaults leave randomUUID unbound', () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-identity-'));
  roots.push(home);
  const handle = openDb({ home });
  closes.push(handle.close);
  const issued = createAgentIdentityService(handle.sqlite).issueCredential(INPUT);
  expect(issued.accessToken.startsWith(AGENT_ACCESS_TOKEN_PREFIX)).toBe(true);
  expect(issued.refreshToken.startsWith(AGENT_REFRESH_TOKEN_PREFIX)).toBe(true);
  expect(createAgentIdentityService(handle.sqlite).authenticateAccessToken(issued.accessToken)).toMatchObject({
    status: 'valid',
  });
});
