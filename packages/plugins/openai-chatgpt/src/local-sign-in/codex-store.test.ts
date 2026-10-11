import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readdir, readlink, rm, stat, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OAuthCredentialImportContext } from '@aio-proxy/plugin-sdk';

import type { ChatGPTCredential } from '../schema';
import { CodexSignInInvalidError, codexHome, createCodexLocalSignIn } from './index';

const context: OAuthCredentialImportContext = {
  progress() {},
  signal: new AbortController().signal,
};
const expiresAt = 1_800_000_000_000;
const accessToken = jwt({
  exp: expiresAt / 1_000,
  'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' },
  email: 'access@example.test',
});
const idToken = jwt({ chatgpt_account_id: 'synthetic-account', email: '  Person@Example.TEST ' });

let home: string;
let path: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'aio-codex-sign-in-'));
  path = join(home, 'auth.json');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function localSignIn(now: () => number = () => 1_790_000_000_000) {
  return createCodexLocalSignIn({ home: () => home, now });
}

function store() {
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: accessToken,
      refresh_token: 'synthetic-refresh-previous',
      id_token: idToken,
      account_id: 'synthetic-account',
      future_token_field: { preserved: true },
    },
    last_refresh: '2026-01-01T00:00:00.000Z',
    future_store_field: { preserved: true },
  };
}

async function put(value: unknown) {
  await Bun.write(path, JSON.stringify(value));
}

function nextCredential(previous: ChatGPTCredential): ChatGPTCredential {
  return {
    ...previous,
    accessToken: jwt({ exp: 1_900_000_000, chatgpt_account_id: previous.accountId }),
    refreshToken: 'synthetic-refresh-next',
    idToken: jwt({ email: 'person@example.test' }),
    expiresAt: 1_900_000_000_000,
  };
}

describe('Codex local sign-in', () => {
  test('resolves an explicit CODEX_HOME or the default directory without reading it', () => {
    expect(codexHome({ CODEX_HOME: home })).toBe(home);
    expect(codexHome({})).toBe(join(homedir(), '.codex'));
  });

  test('detect is false when auth.json is absent', async () => {
    expect(await localSignIn().detect(context)).toBe(false);
  });

  test('detect is true for an unreadable file and never parses its contents', async () => {
    await Bun.write(path, 'synthetic-unreadable-malformed-secret');
    await chmod(path, 0o000);
    try {
      expect(await localSignIn().detect(context)).toBe(true);
    } finally {
      await chmod(path, 0o600);
    }
  });

  test.each([
    'synthetic-malformed-json-secret',
    JSON.stringify({ synthetic_secret: 'synthetic-missing-tokens-secret' }),
    JSON.stringify({ ...store(), auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-api-key-secret' }),
    JSON.stringify({ ...store(), tokens: { access_token: accessToken } }),
    JSON.stringify({ ...store(), tokens: { access_token: '', refresh_token: 'synthetic-empty-access-secret' } }),
    JSON.stringify({ ...store(), tokens: { access_token: accessToken, refresh_token: '' } }),
    JSON.stringify({ ...store(), tokens: [] }),
    JSON.stringify([]),
    JSON.stringify(null),
    JSON.stringify({ ...store(), tokens: { access_token: 'synthetic-opaque-secret', refresh_token: 'refresh' } }),
    JSON.stringify({
      ...store(),
      tokens: { access_token: jwt({ chatgpt_account_id: 'account' }), refresh_token: 'refresh' },
    }),
  ])('read rejects an invalid store without exposing fixture values (case %#)', async (contents) => {
    await Bun.write(path, contents);
    let caught: unknown;
    try {
      await localSignIn().read(context, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CodexSignInInvalidError);
    if (!(caught instanceof Error)) throw new Error('expected safe local sign-in error');
    expect(caught.message).toBe('Codex local sign-in is invalid or incomplete');
    expect(caught.cause).toBeUndefined();
    const surface = [caught.message, caught.stack, JSON.stringify(caught), ...Object.values(caught)].join('\n');
    for (const secret of [
      accessToken,
      idToken,
      'synthetic-refresh-previous',
      ...contents.matchAll(/synthetic-[\w-]+/g),
    ]) {
      expect(surface).not.toContain(String(secret));
    }
  });

  test('read has browser login identity and JWT expiry on both the credential and result', async () => {
    await put(store());
    const result = await localSignIn().read(context, {});
    expect(result).toEqual({
      fingerprint: 'synthetic-account',
      suggestedKey: 'chatgpt-synthetic-account',
      accountLabel: 'person@example.test',
      credentials: {
        accessToken,
        refreshToken: 'synthetic-refresh-previous',
        idToken,
        accountId: 'synthetic-account',
        email: 'person@example.test',
        expiresAt,
      },
      expiresAt,
    });
    expect(await localSignIn(() => 0).read(context, {})).toEqual(result);
    expect(await localSignIn(() => Number.MAX_SAFE_INTEGER).read(context, {})).toEqual(result);
  });

  test.each([undefined, 'chatgpt', 'chatgpt_auth_tokens'])('accepts ChatGPT auth mode %s', async (authMode) => {
    await put({ ...store(), auth_mode: authMode });
    expect((await localSignIn().read(context, {})).fingerprint).toBe('synthetic-account');
  });

  test('explicit account_id wins over JWT account claims', async () => {
    await put({ ...store(), tokens: { ...store().tokens, account_id: 'explicit-account' } });
    const result = await localSignIn().read(context, {});
    expect(result.fingerprint).toBe('explicit-account');
    expect(result.credentials.accountId).toBe('explicit-account');
  });

  test('id_token and account_id are optional, with email and account resolved from the access JWT', async () => {
    await put({ tokens: { access_token: accessToken, refresh_token: 'synthetic-refresh-previous' } });
    const result = await localSignIn().read(context, {});
    expect(result.accountLabel).toBe('access@example.test');
    expect(result.fingerprint).toBe('synthetic-account');
    expect(result.credentials).not.toHaveProperty('idToken');
  });

  test('resolves account from id_token and falls back to the account id as the label', async () => {
    await put({
      tokens: {
        access_token: jwt({ exp: expiresAt / 1_000 }),
        refresh_token: 'synthetic-refresh-previous',
        id_token: jwt({ chatgpt_account_id: 'id-account' }),
      },
    });
    const result = await localSignIn().read(context, {});
    expect(result.fingerprint).toBe('id-account');
    expect(result.accountLabel).toBe('id-account');
  });

  test('write preserves host fields, sets last_refresh, and replaces with mode 0600 even after abort', async () => {
    const original = { ...store(), OPENAI_API_KEY: 'synthetic-preserved-api-key' };
    await put(original);
    await chmod(path, 0o644);
    const signIn = localSignIn();
    const previous = (await signIn.read(context, {})).credentials;
    const next = nextCredential(previous);
    const controller = new AbortController();
    controller.abort();
    await signIn.write!({ signal: controller.signal }, next, previous);
    expect(await Bun.file(path).json()).toEqual({
      ...original,
      tokens: {
        ...original.tokens,
        access_token: next.accessToken,
        refresh_token: next.refreshToken,
        id_token: next.idToken,
        account_id: next.accountId,
      },
      last_refresh: new Date(1_790_000_000_000).toISOString(),
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(home)).toEqual(['auth.json']);
  });

  test('write preserves the host id_token when next has none', async () => {
    await put(store());
    const signIn = localSignIn();
    const previous = (await signIn.read(context, {})).credentials;
    const { idToken: _idToken, ...next } = nextCredential(previous);
    await signIn.write!(context, next, previous);
    expect((await Bun.file(path).json()).tokens.id_token).toBe(idToken);
  });

  test.each(['refresh', 'account', 'mode', 'malformed'] as const)(
    'write skips when the host changes before writing (%s)',
    async (change) => {
      await put(store());
      const signIn = localSignIn();
      const previous = (await signIn.read(context, {})).credentials;
      await changeHost(change);
      const before = await Bun.file(path).text();
      await signIn.write!(context, nextCredential(previous), previous);
      expect(await Bun.file(path).text()).toBe(before);
      expect(await readdir(home)).toEqual(['auth.json']);
    },
  );

  test.each(['refresh', 'account', 'mode', 'malformed'] as const)(
    'write rechecks the host immediately before replace (%s)',
    async (change) => {
      await put(store());
      const previous = (await localSignIn().read(context, {})).credentials;
      let concurrentContents = '';
      const signIn = localSignIn(() => {
        concurrentContents = changedContents(change);
        writeFileSync(path, concurrentContents);
        return 1_790_000_000_000;
      });
      await signIn.write!(context, nextCredential(previous), previous);
      expect(concurrentContents).not.toBe('');
      expect(await Bun.file(path).text()).toBe(concurrentContents);
      expect(await readdir(home)).toEqual(['auth.json']);
    },
  );

  test('write succeeds without tokens.account_id when the JWT resolves the previous account', async () => {
    await put({ ...store(), tokens: { access_token: accessToken, refresh_token: 'synthetic-refresh-previous' } });
    const signIn = localSignIn();
    const previous = (await signIn.read(context, {})).credentials;
    const next = nextCredential(previous);
    await signIn.write!(context, next, previous);
    expect((await Bun.file(path).json()).tokens).toMatchObject({
      account_id: previous.accountId,
      refresh_token: next.refreshToken,
    });
  });

  test('write skips a changed JWT account when account_id is absent', async () => {
    await put(store());
    const signIn = localSignIn();
    const previous = (await signIn.read(context, {})).credentials;
    await put({
      tokens: {
        access_token: jwt({ exp: expiresAt / 1_000, chatgpt_account_id: 'different-account' }),
        refresh_token: previous.refreshToken,
      },
    });
    const before = await Bun.file(path).text();
    await signIn.write!(context, nextCredential(previous), previous);
    expect(await Bun.file(path).text()).toBe(before);
  });

  test('write through a symlink updates its target and preserves the link', async () => {
    const target = join(home, 'codex-target.json');
    await Bun.write(target, JSON.stringify(store()));
    await symlink('codex-target.json', path);
    const signIn = localSignIn();
    const previous = (await signIn.read(context, {})).credentials;
    const next = nextCredential(previous);
    await signIn.write!(context, next, previous);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readlink(path)).toBe('codex-target.json');
    expect((await Bun.file(target).json()).tokens.refresh_token).toBe(next.refreshToken);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect((await readdir(home)).sort()).toEqual(['auth.json', 'codex-target.json']);
  });
});

function changedContents(change: 'refresh' | 'account' | 'mode' | 'malformed') {
  const changed = store();
  if (change === 'refresh') changed.tokens.refresh_token = 'synthetic-host-refreshed';
  if (change === 'account') changed.tokens.account_id = 'different-account';
  if (change === 'mode') changed.auth_mode = 'apikey';
  return change === 'malformed' ? 'synthetic-concurrent-malformed-secret' : JSON.stringify(changed);
}

async function changeHost(change: 'refresh' | 'account' | 'mode' | 'malformed') {
  await Bun.write(path, changedContents(change));
}

function jwt(payload: object) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'synthetic-signature',
  ].join('.');
}
