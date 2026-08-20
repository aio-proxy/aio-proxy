import { expect, mock, test } from 'bun:test';

import { AgentInstallationTargetMismatchError, type AgentIdentityService } from '@aio-proxy/core';

import { createDeviceChallengeStore } from './device-challenges';

const DEVICE_REQUEST = {
  client_id: 'aio-proxy-opencode',
  agent: 'opencode',
  installation_id: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  adapter_version: '1.2.3',
} as const;
const uuid = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

function challengeFixture() {
  let timestamp = 1_000;
  let sequence = 1;
  const issueCredential = mock(() => ({
    accessToken: 'aio_agent_at_v1_access',
    refreshToken: 'aio_agent_rt_v1_refresh',
    expiresIn: 900 as const,
    accessExpiresAt: timestamp + 900_000,
    refreshExpiresAt: timestamp + 90 * 24 * 60 * 60_000,
  }));
  const deps = {
    identity: { issueCredential } as Pick<AgentIdentityService, 'issueCredential'>,
    verificationUri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
    now: () => timestamp,
    randomBytes: (size: number) => {
      let value = sequence++;
      const bytes = Buffer.alloc(size);
      for (let index = 0; index < size; index += 1) {
        bytes[index] = value % 32;
        value = Math.floor(value / 32);
      }
      return bytes;
    },
    randomUUID: () => uuid(sequence++),
  };
  return {
    issueCredential,
    store: createDeviceChallengeStore(deps),
    newStore: () => createDeviceChallengeStore(deps),
    advance: (milliseconds: number) => {
      timestamp += milliseconds;
    },
  };
}

test('pending, slow_down, approval, and duplicate consume are deterministic', () => {
  const f = challengeFixture();
  const created = f.store.create(DEVICE_REQUEST, '127.0.0.1');
  expect(f.store.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: created.device_code }, '127.0.0.1')).toEqual({
    ok: false,
    error: 'slow_down',
    interval: 10,
  });
  expect(f.issueCredential).not.toHaveBeenCalled();
  f.advance(10_000);
  expect(f.store.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: created.device_code }, '127.0.0.1')).toEqual({
    ok: false,
    error: 'authorization_pending',
  });
  const details = f.store.resolve(created.user_code, '127.0.0.1');
  expect(details).toMatchObject({
    status: 'pending',
    target: 'opencode',
    installationId: DEVICE_REQUEST.installation_id,
  });
  if (details.status !== 'pending') throw new Error('expected pending challenge');
  expect(f.store.approve(details.deviceId, '127.0.0.1')).toBe('approved');
  f.advance(10_000);
  const first = f.store.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: created.device_code }, '127.0.0.1');
  const duplicate = f.store.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: created.device_code }, '127.0.0.1');
  expect(first).toEqual(duplicate);
  expect(f.issueCredential).toHaveBeenCalledTimes(1);
  f.advance(30_001);
  expect(f.store.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: created.device_code }, '127.0.0.1')).toEqual({
    ok: false,
    error: 'expired_token',
  });
});

test('deny and expiry never issue credentials', () => {
  const denied = challengeFixture();
  const first = denied.store.create(DEVICE_REQUEST, '127.0.0.1');
  const firstDetails = denied.store.resolve(first.user_code, '127.0.0.1');
  if (firstDetails.status !== 'pending') throw new Error('expected pending challenge');
  expect(denied.store.deny(firstDetails.deviceId, '127.0.0.1')).toBe('denied');
  expect(denied.store.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: first.device_code }, '127.0.0.1')).toEqual(
    {
      ok: false,
      error: 'access_denied',
    },
  );

  const expired = challengeFixture();
  const second = expired.store.create(DEVICE_REQUEST, '127.0.0.1');
  expired.advance(600_001);
  expect(
    expired.store.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: second.device_code }, '127.0.0.1'),
  ).toEqual({
    ok: false,
    error: 'expired_token',
  });
  expect(denied.issueCredential).not.toHaveBeenCalled();
  expect(expired.issueCredential).not.toHaveBeenCalled();
});

test('the first approval decision is terminal', () => {
  const denied = challengeFixture();
  const deniedCode = denied.store.create(DEVICE_REQUEST, '127.0.0.1');
  const deniedDetails = denied.store.resolve(deniedCode.user_code, '127.0.0.1');
  if (deniedDetails.status !== 'pending') throw new Error('expected pending challenge');
  expect(denied.store.deny(deniedDetails.deviceId, '127.0.0.1')).toBe('denied');
  expect(denied.store.approve(deniedDetails.deviceId, '127.0.0.1')).toBe('denied');

  const approved = challengeFixture();
  const approvedCode = approved.store.create(DEVICE_REQUEST, '127.0.0.1');
  const approvedDetails = approved.store.resolve(approvedCode.user_code, '127.0.0.1');
  if (approvedDetails.status !== 'pending') throw new Error('expected pending challenge');
  expect(approved.store.approve(approvedDetails.deviceId, '127.0.0.1')).toBe('approved');
  expect(approved.store.deny(approvedDetails.deviceId, '127.0.0.1')).toBe('approved');
});

test('new login replaces the same installation challenge and restart forgets pending state', () => {
  const f = challengeFixture();
  const old = f.store.create(DEVICE_REQUEST, '127.0.0.1');
  const current = f.store.create(DEVICE_REQUEST, '127.0.0.1');
  expect(f.store.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: old.device_code }, '127.0.0.1')).toEqual({
    ok: false,
    error: 'expired_token',
  });
  expect(current.device_code).not.toBe(old.device_code);
  const restarted = f.newStore();
  expect(restarted.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: current.device_code }, '127.0.0.1')).toEqual({
    ok: false,
    error: 'expired_token',
  });
});

test('an immutable installation-target conflict becomes invalid_grant without consumption', () => {
  const f = challengeFixture();
  f.issueCredential.mockImplementation(() => {
    throw new AgentInstallationTargetMismatchError();
  });
  const created = f.store.create(DEVICE_REQUEST, '127.0.0.1');
  f.advance(5_000);
  const details = f.store.resolve(created.user_code, '127.0.0.1');
  if (details.status !== 'pending') throw new Error('expected pending challenge');
  f.store.approve(details.deviceId, '127.0.0.1');
  const poll = () =>
    f.store.poll(
      {
        clientId: DEVICE_REQUEST.client_id,
        deviceCode: created.device_code,
      },
      '127.0.0.1',
    );
  expect(poll()).toEqual({ ok: false, error: 'invalid_grant' });
  f.advance(5_000);
  expect(poll()).toEqual({ ok: false, error: 'invalid_grant' });
});

test('a new challenge after consume keeps the old device-code replay alive', () => {
  const f = challengeFixture();
  const old = f.store.create(DEVICE_REQUEST, '127.0.0.1');
  const details = f.store.resolve(old.user_code, '127.0.0.1');
  if (details.status !== 'pending') throw new Error('expected pending challenge');
  f.store.approve(details.deviceId, '127.0.0.1');
  const first = f.store.poll(
    {
      clientId: DEVICE_REQUEST.client_id,
      deviceCode: old.device_code,
    },
    '127.0.0.1',
  );

  const current = f.store.create(DEVICE_REQUEST, '127.0.0.1');
  const replay = f.store.poll(
    {
      clientId: DEVICE_REQUEST.client_id,
      deviceCode: old.device_code,
    },
    '127.0.0.1',
  );
  expect(current.device_code).not.toBe(old.device_code);
  expect(replay).toEqual(first);
  expect(f.issueCredential).toHaveBeenCalledTimes(1);
});

test('a consume just before Device expiry still has a full 30-second replay window', () => {
  const f = challengeFixture();
  const created = f.store.create(DEVICE_REQUEST, '127.0.0.1');
  f.advance(599_999);
  const details = f.store.resolve(created.user_code, '127.0.0.1');
  if (details.status !== 'pending') throw new Error('expected pending challenge');
  f.store.approve(details.deviceId, '127.0.0.1');
  const request = {
    clientId: DEVICE_REQUEST.client_id,
    deviceCode: created.device_code,
  } as const;
  const first = f.store.poll(request, '127.0.0.1');
  f.advance(29_999);
  expect(f.store.poll(request, '127.0.0.1')).toEqual(first);
  f.advance(1);
  expect(f.store.poll(request, '127.0.0.1')).toEqual({ ok: false, error: 'expired_token' });
  expect(f.issueCredential).toHaveBeenCalledTimes(1);
});

test('caps every retained challenge and rate-limits each source bucket', () => {
  const f = challengeFixture();
  for (let index = 0; index < 256; index += 1) {
    f.store.create({ ...DEVICE_REQUEST, installation_id: uuid(index) }, `127.0.0.${index + 1}`);
  }
  expect(() => f.store.create({ ...DEVICE_REQUEST, installation_id: uuid(999) }, '127.0.1.1')).toThrow(
    expect.objectContaining({ status: 429 }),
  );

  const limited = challengeFixture();
  for (let index = 0; index < 10; index += 1) {
    limited.store.create({ ...DEVICE_REQUEST, installation_id: uuid(index) }, '127.0.0.1');
  }
  expect(() => limited.store.create({ ...DEVICE_REQUEST, installation_id: uuid(11) }, '127.0.0.1')).toThrow(
    expect.objectContaining({ status: 429 }),
  );
});

test.each(['resolve', 'decision'] as const)('%s rate limit resets after one minute', (kind) => {
  const f = challengeFixture();
  const call =
    kind === 'resolve'
      ? () => f.store.resolve('ZZZZ-ZZZZ', '127.0.0.1')
      : () => f.store.approve(uuid(900), '127.0.0.1');
  for (let index = 0; index < 10; index += 1) call();
  expect(call).toThrow(expect.objectContaining({ status: 429 }));
  f.advance(60_001);
  expect(call).not.toThrow();
});

test('rate-source maps are bounded and expired buckets are reusable', () => {
  const f = challengeFixture();
  for (let index = 0; index < 256; index += 1) {
    f.store.resolve('ZZZZ-ZZZZ', `127.0.1.${index}`);
  }
  expect(() => f.store.resolve('ZZZZ-ZZZZ', '127.0.2.1')).toThrow(
    expect.objectContaining({ status: 429, code: 'rate_limited' }),
  );
  f.advance(60_001);
  expect(() => f.store.resolve('ZZZZ-ZZZZ', '127.0.2.1')).not.toThrow();
});
