import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';

import { type CredentialPort, CredentialRefreshError, type OAuthLocalSignIn, zod } from '@aio-proxy/plugin-sdk';

import { createCredentialPort } from '../credential-port';
import type { PluginLogSink } from '../diagnostic';
import { account, createAccount, openRepository } from '../repository/test-support';
import {
  linkLocalSignInCredentials,
  LocalSignInAccountChangedError,
  localSignInDigest,
  LocalSignInSupersededError,
  LocalSignInUnavailableError,
} from './index';

type Credential = { readonly accessToken: string; readonly refreshToken: string };
const credential = (token: string): Credential => ({ accessToken: `access:${token}`, refreshToken: token });
const fixtures: { readonly home: string; readonly close: () => void }[] = [];

afterEach(() => {
  for (const fixture of fixtures) {
    fixture.close();
    rmSync(fixture.home, { recursive: true, force: true });
  }
  fixtures.length = 0;
});

function setup(linked = true, consumed?: string) {
  const { home, handle, repository } = openRepository();
  fixtures.push({ home, close: () => handle.close() });
  createAccount(
    repository,
    account('provider-1', {
      credential: credential('mirror-initial'),
      ...(linked ? { localSignIn: consumed === undefined ? {} : { consumed } } : {}),
    }),
  );
  const fingerprint = 'provider-1-fingerprint';
  const host = {
    fingerprint,
    credentials: credential('host-initial'),
    readError: undefined as unknown,
    writeError: undefined as unknown,
    writeFailures: 0,
    reads: 0,
    writes: [] as { readonly next: unknown; readonly previous: unknown; readonly aborted: boolean }[],
  };
  const logs: Parameters<PluginLogSink>[0][] = [];
  const writeFailures: unknown[][] = [];
  const options = { tenant: 'test' };
  const localSignIn: OAuthLocalSignIn<unknown, unknown> = {
    source: { default: 'Test host' },
    detect: async () => true,
    async read(context, receivedOptions) {
      expect(context.signal).toBeInstanceOf(AbortSignal);
      expect(receivedOptions).toBe(options);
      host.reads++;
      if (host.readError !== undefined) throw host.readError;
      return { fingerprint: host.fingerprint, suggestedKey: 'test', credentials: host.credentials };
    },
    async write({ signal }, next, previous) {
      host.writes.push({ next, previous, aborted: signal.aborted });
      if (host.writeError !== undefined) throw host.writeError;
      if (host.writeFailures > 0) {
        host.writeFailures--;
        throw new Error(`Cannot write ${host.credentials.refreshToken}`);
      }
      // Matches the host adapter contract: replace only the same account and observed refresh token.
      if (host.fingerprint === fingerprint && host.credentials.refreshToken === (previous as Credential).refreshToken) {
        host.credentials = next as Credential;
      }
    },
  };
  const rawPort = createCredentialPort<unknown>({
    providerId: 'provider-1',
    repository,
    schema: zod.object({ accessToken: zod.string(), refreshToken: zod.string() }),
    diagnostics: (code, context) => ({
      code,
      summary: 'Credential refresh failed',
      retryable: context.retryable,
      occurredAt: '2026-10-02T00:00:00.000Z',
    }),
    logger: (entry) => logs.push(entry),
    onDiagnosticChanged: () => {},
    onCredentialChanged: () => {},
  });
  const accountState = () => {
    const stored = repository.readAccount('provider-1');
    return stored === null
      ? null
      : {
          revision: stored.revision,
          linked: stored.localSignIn !== undefined,
          ...(stored.localSignIn?.consumed === undefined ? {} : { consumed: stored.localSignIn.consumed }),
        };
  };
  const link = (port: CredentialPort<unknown> = rawPort, readAccount = accountState) =>
    linkLocalSignInCredentials(port, {
      localSignIn,
      options,
      fingerprint,
      account: readAccount,
      onWriteFailed: (...args: unknown[]) => writeFailures.push(args),
    });
  const exchangeState = {
    inputs: [] as Credential[],
    used: new Set<string>(),
    error: undefined as unknown,
    afterConsume: () => {},
  };
  const exchange: Parameters<CredentialPort<unknown>['refresh']>[1] = async (current) => {
    const value = current.value as Credential;
    exchangeState.inputs.push(value);
    if (exchangeState.error !== undefined) throw exchangeState.error;
    if (exchangeState.used.has(value.refreshToken)) throw new Error(`Already consumed ${value.refreshToken}`);
    exchangeState.used.add(value.refreshToken);
    exchangeState.afterConsume();
    return {
      value: credential(`${value.refreshToken}:next`),
      metadata: { accountLabel: 'Refreshed account', expiresAt: 999_999 },
    };
  };
  const port = link();
  const refresh = async () => port.refresh((await port.read()).revision, exchange);
  const browserLogin = () => {
    const current = repository.readAccount('provider-1')!;
    const pending = repository.stageAccountOperation({
      kind: 'update',
      targetDigest: 'browser-login',
      expectedRuntimeRevision: current.runtimeRevision,
      account: account('provider-1', { credential: credential('browser-login') }),
    });
    repository.completeAccountOperation(pending.operationId);
  };
  return {
    handle,
    repository,
    host,
    logs,
    writeFailures,
    exchangeState,
    exchange,
    rawPort,
    link,
    port,
    refresh,
    browserLogin,
  };
}

test('uses the host observation when the host refreshed on its own', async () => {
  const f = setup();
  f.host.credentials = credential('host-refreshed');
  await f.refresh();
  expect(f.exchangeState.inputs).toEqual([credential('host-refreshed')]);
  expect(f.host.credentials).toEqual(credential('host-refreshed:next'));
  expect(f.repository.readAccount('provider-1')).toMatchObject({
    credential: f.host.credentials,
    localSignIn: { consumed: localSignInDigest(credential('host-refreshed')) },
    label: 'Refreshed account',
    expiresAt: 999_999,
    revision: 2,
  });
});

test('after a failed write-back, uses the mirror and repairs the host', async () => {
  const f = setup();
  f.host.writeFailures = 1;
  await f.refresh();
  expect(f.host.credentials).toEqual(credential('host-initial'));
  await f.refresh();
  expect(f.exchangeState.inputs).toEqual([credential('host-initial'), credential('host-initial:next')]);
  expect(f.host.credentials).toEqual(credential('host-initial:next:next'));
  expect(f.repository.readAccount('provider-1')?.localSignIn).toEqual({
    consumed: localSignInDigest(credential('host-initial')),
  });
  expect(f.writeFailures).toEqual([[]]);
});

test('two failed write-backs in a row still recover on the third refresh', async () => {
  const f = setup();
  f.host.writeFailures = 2;
  await f.refresh();
  await f.refresh();
  await f.refresh();
  expect(f.exchangeState.inputs).toEqual([
    credential('host-initial'),
    credential('host-initial:next'),
    credential('host-initial:next:next'),
  ]);
  expect(f.host.credentials).toEqual(credential('host-initial:next:next:next'));
  expect(f.repository.readAccount('provider-1')?.credential).toEqual(f.host.credentials);
  expect(f.writeFailures).toEqual([[], []]);
});

test('writes back with the observed host credential as previous and skips when the host changed during exchange', async () => {
  const f = setup();
  f.host.writeFailures = 1;
  await f.refresh();
  f.exchangeState.afterConsume = () => {
    f.host.credentials = credential('host-concurrent');
  };
  await f.refresh();
  expect(f.host.writes[1]).toMatchObject({
    next: credential('host-initial:next:next'),
    previous: credential('host-initial'),
  });
  expect(f.host.credentials).toEqual(credential('host-concurrent'));
  f.exchangeState.afterConsume = () => {};
  await f.refresh();
  expect(f.exchangeState.inputs[2]).toEqual(credential('host-concurrent'));
});

test('a failing write still saves the rotated credential and its digest in one CAS', async () => {
  const f = setup();
  f.host.writeFailures = 1;
  // Observe every account UPDATE, including any attempted standalone digest write.
  f.handle.sqlite.run(`CREATE TABLE account_updates (credential_json TEXT, consumed TEXT);
    CREATE TRIGGER observe_account_update AFTER UPDATE ON oauth_account BEGIN
      INSERT INTO account_updates VALUES (NEW.credential_json, NEW.local_sign_in_consumed);
    END;`);
  await f.refresh();
  expect(f.handle.sqlite.query('SELECT * FROM account_updates').all()).toEqual([
    {
      credential_json: JSON.stringify(credential('host-initial:next')),
      consumed: localSignInDigest(credential('host-initial')),
    },
  ]);
  expect(f.repository.readAccount('provider-1')).toMatchObject({
    revision: 2,
    localSignIn: { consumed: localSignInDigest(credential('host-initial')) },
  });
});

test('a failed exchange records nothing, so the next refresh still uses the host observation', async () => {
  const f = setup();
  const before = f.repository.readAccount('provider-1');
  f.exchangeState.error = new Error('temporary exchange failure');
  await expect(f.refresh()).rejects.toThrow('temporary exchange failure');
  expect(f.repository.readAccount('provider-1')).toEqual(before);
  expect(f.host.writes).toEqual([]);
  f.exchangeState.error = undefined;
  await f.refresh();
  expect(f.exchangeState.inputs).toEqual([credential('host-initial'), credential('host-initial')]);
});

test('writes back even after the signal aborted, because the host token was consumed', async () => {
  const f = setup();
  const controller = new AbortController();
  const port = f.link({
    ...f.rawPort,
    refresh: (revision, exchange) => f.rawPort.refresh(revision, (current) => exchange(current, controller.signal)),
  });
  f.exchangeState.afterConsume = () => controller.abort();
  await port.refresh((await port.read()).revision, f.exchange);
  expect(f.host.writes).toEqual([
    { next: credential('host-initial:next'), previous: credential('host-initial'), aborted: true },
  ]);
  expect(f.host.credentials).toEqual(credential('host-initial:next'));
});

test.each([false, true])(
  'a browser re-login between snapshot and wrapper lets the current request use the new snapshot (previously linked: %s)',
  async (linked) => {
    const f = setup(linked, 'previous-digest');
    // A linked snapshot can hold the host's token even after browser login clears the marker.
    if (linked) f.host.credentials = credential('mirror-initial');
    const hostBefore = f.host.credentials;
    const port = f.link(f.rawPort, () => {
      f.browserLogin();
      const current = f.repository.readAccount('provider-1')!;
      return { revision: current.revision, linked: false };
    });
    const current = await port.read();
    const refreshed = await port.refresh(current.revision, f.exchange);
    expect(refreshed.status).toBe('superseded');
    // Request consumers await refresh and immediately use its snapshot, without retrying.
    expect(refreshed.snapshot.value).toEqual(credential('browser-login'));
    expect(refreshed.snapshot.revision).toBe(current.revision + 1);
    expect(f.exchangeState.inputs).toEqual([]);
    expect(f.exchangeState.used.size).toBe(0);
    expect(f.host.reads).toBe(0);
    expect(f.host.writes).toEqual([]);
    expect(f.host.credentials).toEqual(hostBefore);
    expect(f.writeFailures).toEqual([]);
    expect(f.repository.readAccount('provider-1')?.credential).toEqual(credential('browser-login'));
    expect(f.handle.sqlite.query('SELECT local_sign_in, local_sign_in_consumed FROM oauth_account').get()).toEqual({
      local_sign_in: 0,
      local_sign_in_consumed: null,
    });
    expect(f.logs).toEqual([]);
    expect(f.repository.readDiagnostics('provider-1')).toEqual([]);
  },
);

test.each([false, true])(
  'a linked re-login between snapshot and wrapper returns the new snapshot without consuming a token (previously linked: %s)',
  async (linked) => {
    const f = setup(linked, 'previous-digest');
    const hostBefore = f.host.credentials;
    const port = f.link(f.rawPort, () => {
      const current = f.repository.readAccount('provider-1')!;
      const pending = f.repository.stageAccountOperation({
        kind: 'update',
        targetDigest: 'linked-login',
        expectedRuntimeRevision: current.runtimeRevision,
        account: account('provider-1', { credential: credential('linked-login'), localSignIn: {} }),
      });
      f.repository.completeAccountOperation(pending.operationId);
      return { revision: f.repository.readAccount('provider-1')!.revision, linked: true };
    });
    const current = await port.read();
    expect(await port.refresh(current.revision, f.exchange)).toEqual({
      status: 'superseded',
      snapshot: { revision: current.revision + 1, value: credential('linked-login') },
    });
    expect(f.exchangeState.inputs).toEqual([]);
    expect(f.exchangeState.used.size).toBe(0);
    expect(f.host.reads).toBe(0);
    expect(f.host.writes).toEqual([]);
    expect(f.host.credentials).toEqual(hostBefore);
    expect(f.writeFailures).toEqual([]);
    expect(f.repository.readAccount('provider-1')).toMatchObject({
      revision: current.revision + 1,
      credential: credential('linked-login'),
      localSignIn: {},
    });
    expect(f.logs).toEqual([]);
    expect(f.repository.readDiagnostics('provider-1')).toEqual([]);
  },
);

test('a browser re-login during exchange leaves the marker and digest cleared (CAS rejects the late result)', async () => {
  const f = setup(true, 'previous-digest');
  f.exchangeState.afterConsume = f.browserLogin;
  expect(await f.refresh()).toEqual({
    status: 'superseded',
    snapshot: { revision: 2, value: credential('browser-login') },
  });
  expect(f.repository.readAccount('provider-1')?.localSignIn).toBeUndefined();
  expect(f.handle.sqlite.query('SELECT local_sign_in, local_sign_in_consumed FROM oauth_account').get()).toEqual({
    local_sign_in: 0,
    local_sign_in_consumed: null,
  });
});

test('fails non-retryably and does not write when the host holds a different account', async () => {
  const f = setup();
  f.host.fingerprint = 'another-account';
  const error = await f.refresh().catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(LocalSignInAccountChangedError);
  expect(error).toMatchObject({ options: { retryable: false, reason: 'local_sign_in_account_changed' } });
  expect(f.exchangeState.inputs).toEqual([]);
  expect(f.host.writes).toEqual([]);
  expect(f.repository.readAccount('provider-1')?.revision).toBe(1);
  expect(f.repository.readDiagnostics('provider-1')).toHaveLength(1);
});

test('a retryable CredentialRefreshError from exchange stays retryable after redaction', async () => {
  const f = setup();
  f.exchangeState.error = new CredentialRefreshError('upstream rejected host-initial', {
    retryable: true,
    reason: 'upstream_busy',
    status: 503,
  });
  const error = await f.refresh().catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(CredentialRefreshError);
  expect(error).not.toBe(f.exchangeState.error);
  expect(error).toMatchObject({
    message: 'upstream rejected [REDACTED]',
    options: { retryable: true, reason: 'upstream_busy', status: 503 },
  });
  expect(f.repository.readDiagnostics('provider-1')).toEqual([]);
});

test('digest is stable across key order', () => {
  expect(localSignInDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(localSignInDigest({ b: { d: 3, c: 2 }, a: 1 }));
  expect(localSignInDigest([{ a: 1, b: 2 }])).toBe(localSignInDigest([{ b: 2, a: 1 }]));
  expect(localSignInDigest([1, 2])).not.toBe(localSignInDigest([2, 1]));
  expect(localSignInDigest({ a: 1 })).toBe(new Bun.CryptoHasher('sha256').update('{"a":1}').digest('hex'));
});

test('digest sorts the JSON keys of opaque credential instances as well', () => {
  class OpaqueCredential {
    constructor(fields: Record<string, unknown>) {
      Object.assign(this, fields);
    }
  }
  const fields = { b: { d: 3, c: 2 }, a: 1 };
  expect(localSignInDigest(new OpaqueCredential(fields))).toBe(localSignInDigest({ a: 1, b: { c: 2, d: 3 } }));
});

test('errors from read, exchange, and write carry no host credential string in message, stack, or cause', async () => {
  const f = setup();
  const unsafe = new Error('host-initial access:host-initial', { cause: new Error('host-initial') });
  unsafe.stack = 'Error: host-initial access:host-initial\n at host-initial';
  f.host.readError = unsafe;
  const readError = await f.refresh().catch((failure: unknown) => failure);
  expect(readError).toBeInstanceOf(LocalSignInUnavailableError);
  expect(readError).toMatchObject({ options: { retryable: true, reason: 'local_sign_in_unavailable' } });
  f.host.readError = undefined;
  f.exchangeState.error = unsafe;
  const exchangeError = await f.refresh().catch((failure: unknown) => failure);
  expect(exchangeError).toBeInstanceOf(Error);
  expect(exchangeError).not.toBe(unsafe);
  for (const error of [readError, exchangeError] as Error[]) {
    expect(`${error.message}\n${error.stack}`).not.toContain('host-initial');
    expect(error.cause).toBeUndefined();
  }
  f.exchangeState.error = undefined;
  f.host.writeError = unsafe;
  expect((await f.refresh()).status).toBe('updated');
  expect(f.writeFailures).toEqual([[]]);
  expect(JSON.stringify({ logs: f.logs, diagnostics: f.repository.readDiagnostics('provider-1') })).not.toContain(
    'host-initial',
  );
});

test.each(['toJSON', 'getter'])('a throwing credential %s fails safely before exchange', async (kind) => {
  const f = setup(true, 'previous-digest');
  const before = f.repository.readAccount('provider-1');
  const secret = 'synthetic-host-digest-secret';
  const unsafe = new Error(`Cannot serialize ${secret}`, { cause: new Error(secret) });
  unsafe.stack = `Error: ${secret}\n at ${secret}`;
  f.host.credentials = credential(secret);
  const fail = () => {
    throw unsafe;
  };
  Object.defineProperty(
    f.host.credentials,
    kind === 'toJSON' ? 'toJSON' : 'refreshToken',
    kind === 'toJSON' ? { value: fail } : { enumerable: true, get: fail },
  );

  const error = (await f.refresh().catch((failure: unknown) => failure)) as Error;
  expect(error.message).not.toContain(secret);
  expect(error.stack).not.toContain(secret);
  expect(error.cause).toBeUndefined();
  expect(error).not.toBe(unsafe);
  expect(error).toBeInstanceOf(LocalSignInUnavailableError);
  expect(error).toMatchObject({
    message: 'Local sign-in unavailable',
    options: { retryable: true, reason: 'local_sign_in_unavailable' },
  });
  expect(f.logs).toHaveLength(1);
  expect(f.logs[0]).toMatchObject({ event: 'plugin.credential.refresh.failed' });
  expect(JSON.stringify(f.logs)).not.toContain(secret);
  expect(f.repository.readDiagnostics('provider-1')).toEqual([]);
  expect(f.exchangeState.inputs).toEqual([]);
  expect(f.exchangeState.used.size).toBe(0);
  expect(f.host.writes).toEqual([]);
  expect(f.writeFailures).toEqual([]);
  expect(f.repository.readAccount('provider-1')).toEqual(before);
});

test('redacts both the stale host observation and mirror used for exchange', async () => {
  const f = setup(true, localSignInDigest(credential('host-initial')));
  f.exchangeState.error = new Error('host-initial mirror-initial');
  const error = await f.refresh().catch((failure: unknown) => failure);
  expect(error).toMatchObject({ message: '[REDACTED] [REDACTED]' });
  expect((error as Error).stack).not.toMatch(/host-initial|mirror-initial/u);
});

test('unlinked accounts use plain exchange without touching the host', async () => {
  const f = setup(false);
  f.host.readError = new Error('must not read');
  expect(await f.port.read()).toEqual(await f.rawPort.read());
  await f.refresh();
  expect(f.exchangeState.inputs).toEqual([credential('mirror-initial')]);
  expect(f.host.reads).toBe(0);
  expect(f.host.writes).toEqual([]);
  expect(f.repository.readAccount('provider-1')?.localSignIn).toBeUndefined();
});

test('an account deleted between snapshot and wrapper fails retryably without exchange', async () => {
  const f = setup();
  const port = f.link(f.rawPort, () => {
    f.repository.deleteAccount('provider-1');
    return null;
  });
  const error = await port.refresh(1, f.exchange).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(LocalSignInSupersededError);
  expect(error).toMatchObject({ options: { retryable: true, reason: 'local_sign_in_superseded' } });
  expect(f.exchangeState.inputs).toEqual([]);
  expect(f.host.reads).toBe(0);
});

test('a compensated browser login restores the previous link and consumed digest', () => {
  const f = setup(true, 'previous-digest');
  const before = f.repository.readAccount('provider-1');
  const pending = f.repository.stageAccountOperation({
    kind: 'update',
    targetDigest: 'browser-login',
    expectedRuntimeRevision: 1,
    account: account('provider-1', { credential: credential('browser-login') }),
  });
  expect(f.repository.readAccount('provider-1')?.localSignIn).toBeUndefined();
  expect(f.repository.compensateAccountOperation(pending.operationId)).toBe('compensated');
  expect(f.repository.readAccount('provider-1')).toEqual(before);
  expect(f.repository.listAccounts()[0]?.localSignIn).toEqual({ consumed: 'previous-digest' });
});
