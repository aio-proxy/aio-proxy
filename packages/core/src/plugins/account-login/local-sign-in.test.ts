import { afterEach, mock } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { OAuthLocalSignIn, RuntimeFetch } from '@aio-proxy/plugin-sdk';

import * as accountLogin from '.';
import { createCredentialPort } from '../credential-port';
import { linkLocalSignInCredentials, localSignInDigest } from '../local-sign-in';
import {
  accountOf,
  configOf,
  diagnostics,
  emptyCatalog,
  expect,
  fixture,
  loginOAuthAccount,
  options,
  type PluginLogSink,
  ProviderFingerprintMismatchError,
  registry,
  test,
  zod,
} from './test-support';

type Credential = { token: string; refresh?: string };
type LocalSignIn = OAuthLocalSignIn<Record<string, unknown>, Credential>;
const states: ReturnType<typeof fixture>[] = [];

afterEach(() => {
  for (const state of states.splice(0)) {
    state.handle.close();
    rmSync(state.root, { recursive: true, force: true });
  }
});

function setup() {
  const state = fixture();
  states.push(state);
  const path = join(state.root, 'local-sign-in.json');
  const initial: Credential = { token: 'temporary-host-access', refresh: 'temporary-host-refresh' };
  writeFileSync(path, JSON.stringify(initial), { mode: 0o600 });
  const host = () => JSON.parse(readFileSync(path, 'utf8')) as Credential;
  const localSignIn: LocalSignIn = {
    source: 'Example tool',
    detect: mock(async () => existsSync(path)),
    read: mock(async () => ({
      fingerprint: 'person@example.com',
      suggestedKey: 'person',
      accountLabel: 'Local account',
      expiresAt: 1,
      credentials: host(),
    })),
    write: mock(async (_context, next, previous) => {
      if (host().refresh === previous.refresh) writeFileSync(path, JSON.stringify(next), { mode: 0o600 });
    }),
  };
  const createAuthorization = mock(options(state).createAuthorization);
  const login = mock(async () => ({
    fingerprint: 'person@example.com',
    suggestedKey: 'person',
    credentials: { token: 'browser-access' },
  }));
  const logs: Parameters<PluginLogSink>[0][] = [];
  const loginOptions = (controls: Parameters<typeof registry>[0] = {}) =>
    options(state, {
      localSignIn: true,
      registry: registry({ localSignIn, login, ...controls }),
      createAuthorization,
      logger: (entry) => logs.push(entry),
    });
  return { state, path, initial, host, localSignIn, createAuthorization, login, logs, loginOptions };
}

test('stores the read credential and marks the account', async () => {
  const f = setup();
  const fetch = mock(async () => new Response()) as unknown as RuntimeFetch;
  const progress = mock(() => {});
  const renderAccountOptions = mock(async () => ({
    publicValues: { tenant: 'chosen' },
    secrets: { secret: 'chosen-secret' },
  }));
  const onAuthorized = mock(() => {});
  const result = await loginOAuthAccount({
    ...f.loginOptions(),
    fetch,
    progress,
    renderAccountOptions,
    onAuthorized,
  });
  expect(result).toEqual({ providerId: 'person' });
  expect(accountOf(f.state, 'person')).toMatchObject({
    credential: f.initial,
    localSignIn: {},
    options: { tenant: 'chosen' },
    secrets: { secret: 'chosen-secret' },
    label: 'Local account',
    expiresAt: 1,
  });
  expect(f.localSignIn.read).toHaveBeenCalledWith(
    { signal: expect.any(AbortSignal), fetch, progress },
    { tenant: 'chosen', secret: 'chosen-secret' },
  );
  expect(renderAccountOptions).toHaveBeenCalledTimes(1);
  expect(onAuthorized).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(configOf(f.state))).not.toContain('localSignIn');
  expect(JSON.stringify({ result, logs: f.logs, config: configOf(f.state) })).not.toContain(f.initial.token);
});

test('never creates an authorization port', async () => {
  const f = setup();
  await loginOAuthAccount(f.loginOptions());
  expect(f.createAuthorization).not.toHaveBeenCalled();
  expect(f.login).not.toHaveBeenCalled();
});

test('fails with OAUTH_LOCAL_SIGN_IN_UNAVAILABLE when detect is false without calling read', async () => {
  const f = setup();
  const detect = mock(async () => false);
  await expect(loginOAuthAccount(f.loginOptions({ localSignIn: { ...f.localSignIn, detect } }))).rejects.toThrow(
    'OAUTH_LOCAL_SIGN_IN_UNAVAILABLE',
  );
  expect(f.localSignIn.read).not.toHaveBeenCalled();
  expect(f.createAuthorization).not.toHaveBeenCalled();
  expect(f.state.repository.listAccounts()).toEqual([]);
});

test('an adapter without local sign-in fails unavailable without opening authorization', async () => {
  const f = setup();
  await expect(loginOAuthAccount({ ...f.loginOptions(), registry: registry() })).rejects.toThrow(
    'OAUTH_LOCAL_SIGN_IN_UNAVAILABLE',
  );
  expect(f.createAuthorization).not.toHaveBeenCalled();
});

test('a read failure surfaces OAUTH_LOCAL_SIGN_IN_INVALID with no cause', async () => {
  const f = setup();
  const unsafe = new Error(f.initial.token, { cause: new Error(f.initial.refresh) });
  const failure = await loginOAuthAccount(
    f.loginOptions({
      localSignIn: {
        ...f.localSignIn,
        read: async () => {
          throw unsafe;
        },
      },
    }),
  ).catch((error: unknown) => error);
  expect(failure).toMatchObject({ message: 'OAUTH_LOCAL_SIGN_IN_INVALID', name: 'OAuthLocalSignInInvalidError' });
  expect(failure).toBeInstanceOf(accountLogin.OAuthLocalSignInInvalidError);
  expect((failure as Error).cause).toBeUndefined();
  expect(`${(failure as Error).message}\n${(failure as Error).stack}`).not.toContain(f.initial.token);
  expect(JSON.stringify(f.logs)).not.toContain(f.initial.refresh!);
  expect(f.state.repository.listAccounts()).toEqual([]);
});

test('an expired host credential refreshed during discovery is written back to the host', async () => {
  const f = setup();
  const next = { token: 'discovery-access', refresh: 'discovery-refresh' };
  await loginOAuthAccount(
    f.loginOptions({
      discover: async ({ credentials }) => {
        const current = await credentials.read();
        expect(current.value).toEqual(f.initial);
        await credentials.refresh(current.revision, async (base) => {
          expect(base.value).toEqual(f.initial);
          return { value: next, metadata: { expiresAt: 100, accountLabel: 'Refreshed account' } };
        });
        return emptyCatalog();
      },
    }),
  );
  expect(f.host()).toEqual(next);
  expect(f.localSignIn.write).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) }, next, f.initial);
  expect(accountOf(f.state, 'person')).toMatchObject({
    credential: next,
    expiresAt: 100,
    label: 'Refreshed account',
    localSignIn: { consumed: localSignInDigest(f.initial) },
  });
});

test.each([
  ['with write', true],
  ['without write', false],
] as const)(
  'a discovery failure after refresh never exposes previous host credentials (%s)',
  async (_label, writeBack) => {
    const f = setup();
    const { write: _write, ...readOnly } = f.localSignIn;
    const next = { token: 'refreshed-discovery-access', refresh: 'refreshed-discovery-refresh' };
    const retainedRequestError = new Error(`request used ${f.initial.token} ${f.initial.refresh}`, {
      cause: new Error(`request used ${f.initial.refresh}`),
    });
    const result = await loginOAuthAccount(
      f.loginOptions({
        localSignIn: writeBack ? f.localSignIn : readOnly,
        discover: async ({ credentials }) => {
          const current = await credentials.read();
          await credentials.refresh(current.revision, async () => ({ value: next }));
          throw retainedRequestError;
        },
      }),
    );
    expect(accountOf(f.state, 'person').credential).toEqual(next);
    expect(f.state.repository.readDiagnostics('person')).toMatchObject([{ code: 'CATALOG_UNAVAILABLE' }]);
    const exposed = JSON.stringify({ result, logs: f.logs, config: configOf(f.state) });
    for (const value of [f.initial.token, f.initial.refresh!, next.token, next.refresh]) {
      expect(exposed).not.toContain(value);
    }
    expect(f.logs).toMatchObject([
      {
        event: 'plugin.catalog.discovery.failed',
        code: 'CATALOG_UNAVAILABLE',
        error: { name: 'Error', message: 'CATALOG_UNAVAILABLE' },
      },
    ]);
  },
);

test('a write-back failure during discovery persists the consumed digest so the first runtime refresh repairs the host', async () => {
  const f = setup();
  let writeFails = true;
  const localSignIn: LocalSignIn = {
    ...f.localSignIn,
    write: async (_context, next) => {
      if (writeFails) throw new Error(`${f.initial.token} ${f.initial.refresh}`);
      writeFileSync(f.path, JSON.stringify(next), { mode: 0o600 });
    },
  };
  const mirror = { token: 'discovery-access', refresh: 'discovery-refresh' };
  await loginOAuthAccount(
    f.loginOptions({
      localSignIn,
      discover: async ({ credentials }) => {
        const current = await credentials.read();
        await credentials.refresh(current.revision, async () => ({ value: mirror }));
        return emptyCatalog();
      },
    }),
  );
  expect(f.host()).toEqual(f.initial);
  expect(accountOf(f.state, 'person').localSignIn).toEqual({ consumed: localSignInDigest(f.initial) });
  expect(f.logs.map(({ event }) => event)).toContain('plugin.local-sign-in.write.failed');
  expect(JSON.stringify(f.logs)).not.toContain(f.initial.token);
  expect(JSON.stringify(f.logs)).not.toContain(f.initial.refresh!);

  writeFails = false;
  const runtime = linkLocalSignInCredentials(
    createCredentialPort({
      providerId: 'person',
      schema: zod.object({ token: zod.string(), refresh: zod.string().optional() }),
      repository: f.state.repository,
      diagnostics,
      logger: (entry) => f.logs.push(entry),
      onDiagnosticChanged: () => {},
      onCredentialChanged: () => {},
    }),
    {
      localSignIn: localSignIn as OAuthLocalSignIn<unknown, unknown>,
      fingerprint: 'person@example.com',
      options: { tenant: 'work', secret: 'hidden' },
      account: () => {
        const stored = accountOf(f.state, 'person');
        return { revision: stored.revision, linked: stored.localSignIn !== undefined, ...stored.localSignIn };
      },
      onWriteFailed: () => {
        throw new Error('unexpected runtime write failure');
      },
    },
  );
  const next = { token: 'runtime-access', refresh: 'runtime-refresh' };
  const current = await runtime.read();
  await runtime.refresh(current.revision, async (base) => {
    expect(base.value).toEqual(mirror);
    return { value: next };
  });
  expect(f.host()).toEqual(next);
  expect(accountOf(f.state, 'person')).toMatchObject({
    credential: next,
    localSignIn: { consumed: localSignInDigest(f.initial) },
  });
});

test('successive discovery refreshes keep the in-memory revision and consumed digest aligned', async () => {
  const f = setup();
  let latest: Credential = f.initial;
  await loginOAuthAccount(
    f.loginOptions({
      localSignIn: {
        ...f.localSignIn,
        write: async () => {
          throw new Error('temporary write failure');
        },
      },
      discover: async ({ credentials }) => {
        for (let index = 1; index <= 2; index++) {
          const current = await credentials.read();
          const next = { token: `discovery-${index}`, refresh: `refresh-${index}` };
          expect(current.revision).toBe(index - 1);
          const refreshed = await credentials.refresh(current.revision, async (base) => {
            expect(base.value).toEqual(latest);
            return { value: next };
          });
          expect(refreshed.status).toBe('updated');
          latest = next;
        }
        return emptyCatalog();
      },
    }),
  );
  expect(latest).toEqual({ token: 'discovery-2', refresh: 'refresh-2' });
  expect(accountOf(f.state, 'person')).toMatchObject({
    credential: latest,
    localSignIn: { consumed: localSignInDigest(f.initial) },
  });
});

test('re-linking while the host still holds the consumed value fails with OAUTH_LOCAL_SIGN_IN_STALE and leaves the mirror untouched', async () => {
  const f = setup();
  const next = { token: 'valid-mirror', refresh: 'valid-mirror-refresh' };
  const controls: Parameters<typeof registry>[0] = {
    localSignIn: {
      ...f.localSignIn,
      write: async () => {
        throw new Error('temporary write failure');
      },
    },
    discover: async ({ credentials }) => {
      const current = await credentials.read();
      await credentials.refresh(current.revision, async () => ({ value: next }));
      return emptyCatalog();
    },
  };
  await loginOAuthAccount(f.loginOptions(controls));
  const before = accountOf(f.state, 'person');
  const configBefore = readFileSync(f.state.path, 'utf8');
  const discover = mock(async () => emptyCatalog());
  const failure = await loginOAuthAccount({
    ...f.loginOptions({ discover }),
    targetProviderId: 'person',
  }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ message: 'OAUTH_LOCAL_SIGN_IN_STALE', name: 'OAuthLocalSignInStaleError' });
  expect(failure).toBeInstanceOf(accountLogin.OAuthLocalSignInStaleError);
  expect(discover).not.toHaveBeenCalled();
  expect(accountOf(f.state, 'person')).toEqual(before);
  expect(readFileSync(f.state.path, 'utf8')).toBe(configBefore);
  expect(f.state.repository.listPendingAccountOperations()).toEqual([]);
});

test('browser re-login of a marked Provider clears the marker', async () => {
  const f = setup();
  await loginOAuthAccount(
    f.loginOptions({
      discover: async ({ credentials }) => {
        const current = await credentials.read();
        await credentials.refresh(current.revision, async () => ({ value: { token: 'linked-new' } }));
        return emptyCatalog();
      },
    }),
  );
  expect(accountOf(f.state, 'person').localSignIn?.consumed).toBe(localSignInDigest(f.initial));
  const read = mock(f.localSignIn.read);
  const write = mock(f.localSignIn.write!);
  const bytes = readFileSync(f.path, 'utf8');
  await loginOAuthAccount({
    ...f.loginOptions({ localSignIn: { ...f.localSignIn, read, write } }),
    localSignIn: false,
    targetProviderId: 'person',
  });
  expect(accountOf(f.state, 'person').credential).toEqual({ token: 'browser-access' });
  expect(accountOf(f.state, 'person').localSignIn).toBeUndefined();
  expect(f.state.sqlite.query('SELECT local_sign_in, local_sign_in_consumed FROM oauth_account').get()).toEqual({
    local_sign_in: 0,
    local_sign_in_consumed: null,
  });
  expect(f.createAuthorization).toHaveBeenCalledTimes(1);
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(readFileSync(f.path, 'utf8')).toBe(bytes);
});

test('a store without write is copied once and does not re-read the host during discovery refresh', async () => {
  const f = setup();
  const { write: _write, ...localSignIn } = f.localSignIn;
  await loginOAuthAccount(
    f.loginOptions({
      localSignIn,
      discover: async ({ credentials }) => {
        const current = await credentials.read();
        await credentials.refresh(current.revision, async () => ({ value: { token: 'short-lived-access' } }));
        return emptyCatalog();
      },
    }),
  );
  expect(f.localSignIn.read).toHaveBeenCalledTimes(1);
  expect(f.localSignIn.write).not.toHaveBeenCalled();
  expect(accountOf(f.state, 'person')).toMatchObject({ credential: { token: 'short-lived-access' }, localSignIn: {} });
  expect(f.host()).toEqual(f.initial);
});

test('re-linking rejects a different fingerprint before discovery', async () => {
  const f = setup();
  await loginOAuthAccount(f.loginOptions());
  const before = accountOf(f.state, 'person');
  const discover = mock(async () => emptyCatalog());
  await expect(
    loginOAuthAccount({
      ...f.loginOptions({
        localSignIn: {
          ...f.localSignIn,
          read: async () => ({
            fingerprint: 'other@example.com',
            suggestedKey: 'other',
            credentials: f.initial,
          }),
        },
        discover,
      }),
      targetProviderId: 'person',
    }),
  ).rejects.toBeInstanceOf(ProviderFingerprintMismatchError);
  expect(discover).not.toHaveBeenCalled();
  expect(accountOf(f.state, 'person')).toEqual(before);
});

test('re-linking carries the stored consumed digest into discovery when the host returns to the old value', async () => {
  const f = setup();
  const failedWrite: LocalSignIn = {
    ...f.localSignIn,
    write: async () => {
      throw new Error('temporary write failure');
    },
  };
  await loginOAuthAccount(
    f.loginOptions({
      localSignIn: failedWrite,
      discover: async ({ credentials }) => {
        const current = await credentials.read();
        await credentials.refresh(current.revision, async () => ({ value: { token: 'first-mirror' } }));
        return emptyCatalog();
      },
    }),
  );
  const fresh = { token: 'tool-refreshed', refresh: 'tool-refreshed-refresh' };
  writeFileSync(f.path, JSON.stringify(fresh), { mode: 0o600 });
  let reads = 0;
  const localSignIn: LocalSignIn = {
    ...failedWrite,
    read: async () => {
      if (reads++ === 1) writeFileSync(f.path, JSON.stringify(f.initial), { mode: 0o600 });
      return { fingerprint: 'person@example.com', suggestedKey: 'person', credentials: f.host() };
    },
  };
  const bases: unknown[] = [];
  await loginOAuthAccount({
    ...f.loginOptions({
      localSignIn,
      discover: async ({ credentials }) => {
        const current = await credentials.read();
        await credentials.refresh(current.revision, async (base) => {
          bases.push(base.value);
          return { value: { token: 'relinked-mirror' } };
        });
        return emptyCatalog();
      },
    }),
    capability: undefined,
    targetProviderId: 'person',
  });
  expect(bases).toEqual([fresh]);
  expect(accountOf(f.state, 'person')).toMatchObject({
    credential: { token: 'relinked-mirror' },
    localSignIn: { consumed: localSignInDigest(f.initial) },
  });
  expect(f.logs.at(-1)).toMatchObject({
    event: 'plugin.local-sign-in.write.failed',
    context: { plugin: '@example/oauth', capability: 'default', providerId: 'person' },
  });
});

test('successive successful discovery refreshes persist the digest of the latest consumed host value', async () => {
  const f = setup();
  const first = { token: 'discovery-1', refresh: 'refresh-1' };
  const second = { token: 'discovery-2', refresh: 'refresh-2' };
  await loginOAuthAccount(
    f.loginOptions({
      discover: async ({ credentials }) => {
        for (const value of [first, second]) {
          const current = await credentials.read();
          await credentials.refresh(current.revision, async () => ({ value }));
        }
        return emptyCatalog();
      },
    }),
  );
  expect(f.host()).toEqual(second);
  expect(accountOf(f.state, 'person')).toMatchObject({
    credential: second,
    localSignIn: { consumed: localSignInDigest(first) },
  });
});

test('a throwing local login result accessor is normalized without leaking credentials', async () => {
  const f = setup();
  const failure = await loginOAuthAccount(
    f.loginOptions({
      localSignIn: {
        ...f.localSignIn,
        read: async () => ({
          get fingerprint(): string {
            throw new Error(f.initial.token);
          },
          suggestedKey: 'person',
          credentials: f.initial,
        }),
      },
    }),
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(accountLogin.OAuthLocalSignInInvalidError);
  expect((failure as Error).cause).toBeUndefined();
  expect(`${(failure as Error).message}\n${(failure as Error).stack}`).not.toContain(f.initial.token);
});

test('a detection failure surfaces unavailable with no cause or credential details', async () => {
  const f = setup();
  const failure = await loginOAuthAccount(
    f.loginOptions({
      localSignIn: {
        ...f.localSignIn,
        detect: async () => {
          throw new Error(f.initial.token);
        },
      },
    }),
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(accountLogin.OAuthLocalSignInUnavailableError);
  expect((failure as Error).message).toBe('OAUTH_LOCAL_SIGN_IN_UNAVAILABLE');
  expect((failure as Error).cause).toBeUndefined();
  expect(`${(failure as Error).stack}`).not.toContain(f.initial.token);
  expect(f.localSignIn.read).not.toHaveBeenCalled();
});

test('local sign-in preserves cancellation without opening authorization or writing an account', async () => {
  const f = setup();
  const controller = new AbortController();
  const reason = new Error('cancelled');
  await expect(
    loginOAuthAccount({
      ...f.loginOptions({
        localSignIn: {
          ...f.localSignIn,
          read: async () => {
            controller.abort(reason);
            throw reason;
          },
        },
      }),
      signal: controller.signal,
    }),
  ).rejects.toBe(reason);
  expect(f.createAuthorization).not.toHaveBeenCalled();
  expect(f.state.repository.listAccounts()).toEqual([]);
});
