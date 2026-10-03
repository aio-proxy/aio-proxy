import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OAuthAdapter, OAuthCredentialImportContext, RuntimeFetch } from '@aio-proxy/plugin-sdk';

import { loginToGitHubCopilot } from '../github-api/login';
import type { GitHubAccountOptions, GitHubCopilotCredential } from '../github-api/types';
import { createGitHubCopilotPlugin, englishPresentationText } from '../plugin';
import { CopilotSignInInvalidError, copilotConfigDir, createCopilotLocalSignIn } from './index';

declare const __AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__: string;

const clientId = __AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__;
const githubToken = 'synthetic-github-local-token';
const copilotToken = 'tid=synthetic;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;';
const githubOptions: GitHubAccountOptions = { deploymentType: 'github.com' };
const signal = new AbortController().signal;

let configHome: string;
let dir: string;

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), 'aio-copilot-sign-in-'));
  dir = join(configHome, 'github-copilot');
  await mkdir(dir);
});

afterEach(async () => {
  await rm(configHome, { recursive: true, force: true });
});

function localSignIn() {
  return createCopilotLocalSignIn({ dir: () => dir });
}

async function put(file: 'apps.json' | 'hosts.json', value: unknown) {
  await Bun.write(join(dir, file), JSON.stringify(value));
}

function upstream(options: { readonly emailsAvailable?: boolean } = {}) {
  const requests: { readonly url: string; readonly authorization: string | null; readonly signal: unknown }[] = [];
  const fetcher: RuntimeFetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      url: url.href,
      authorization: new Headers(init?.headers).get('authorization'),
      signal: init?.signal,
    });
    if (url.pathname === '/login/device/code') {
      return Response.json({
        device_code: 'synthetic-device',
        user_code: 'ABCD',
        verification_uri: 'https://github.com/login/device',
        interval: 0,
        expires_in: 600,
      });
    }
    if (url.pathname === '/login/oauth/access_token') return Response.json({ access_token: githubToken });
    if (url.pathname.endsWith('/copilot_internal/v2/token')) {
      return Response.json({ token: copilotToken, expires_at: 9_999_999_999 });
    }
    if (url.pathname.endsWith('/user')) return Response.json({ id: 4242, login: 'synthetic-user' });
    if (url.pathname.endsWith('/user/emails')) {
      return options.emailsAvailable === false
        ? new Response('unavailable', { status: 404 })
        : Response.json([{ email: ' Person@Example.TEST ', primary: true, verified: true }]);
    }
    throw new Error('Unexpected synthetic upstream request');
  };
  const context: OAuthCredentialImportContext = { signal, fetch: fetcher, progress() {} };
  return { context, requests };
}

async function expectSafeFailure(run: () => Promise<unknown>, secrets: readonly string[]) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CopilotSignInInvalidError);
  if (!(caught instanceof Error)) throw new Error('Expected safe local sign-in error');
  expect(caught.message).toBe('GitHub Copilot local sign-in is invalid or incomplete');
  expect(caught.cause).toBeUndefined();
  const surface = [caught.message, caught.stack, JSON.stringify(caught), ...Object.values(caught)].join('\n');
  for (const secret of secrets) expect(surface).not.toContain(secret);
}

describe('GitHub Copilot local sign-in', () => {
  test('resolves XDG_CONFIG_HOME or the default path without reading either', () => {
    expect(copilotConfigDir({ XDG_CONFIG_HOME: configHome })).toBe(dir);
    expect(copilotConfigDir({})).toBe(join(homedir(), '.config', 'github-copilot'));
  });

  test('detect is false with neither file', async () => {
    expect(await localSignIn().detect({ signal })).toBe(false);
  });

  test.each(['apps.json', 'hosts.json'] as const)(
    'detect checks presence without reading an unreadable malformed %s',
    async (file) => {
      const path = join(dir, file);
      await Bun.write(path, 'synthetic-malformed-secret');
      await chmod(path, 0o000);
      try {
        expect(await localSignIn().detect({ signal })).toBe(true);
      } finally {
        await chmod(path, 0o600);
      }
    },
  );

  test('prefers the apps.json entry for the plugin client id over other apps and hosts.json', async () => {
    await put('apps.json', {
      'github.com:other-app': { oauth_token: 'synthetic-other-token', githubAppId: clientId },
      [`github.com:${clientId}`]: { oauth_token: githubToken, githubAppId: 'other-app' },
    });
    await put('hosts.json', { 'github.com': { oauth_token: 'synthetic-legacy-token' } });
    const { context, requests } = upstream();
    const result = await localSignIn().read(context, githubOptions);
    expect(result.credentials.githubToken).toBe(githubToken);
    expect(requests.map((request) => request.authorization)).toEqual(Array(3).fill(`Bearer ${githubToken}`));
    expect(requests.every((request) => request.signal === signal)).toBe(true);
  });

  test('uses another app on the selected host before the legacy store', async () => {
    await put('apps.json', {
      [`other.example.test:${clientId}`]: { oauth_token: 'synthetic-other-host-token' },
      'github.com:other-app': { oauth_token: githubToken },
    });
    await put('hosts.json', { 'github.com': { oauth_token: 'synthetic-legacy-token' } });
    expect((await localSignIn().read(upstream().context, githubOptions)).credentials.githubToken).toBe(githubToken);
  });

  test('falls back to hosts.json when apps.json is absent', async () => {
    await put('hosts.json', { 'github.com': { user: 'untrusted-store-user', oauth_token: githubToken } });
    expect((await localSignIn().read(upstream().context, githubOptions)).fingerprint).toBe('4242');
  });

  test('falls back to hosts.json when apps.json has no eligible token', async () => {
    await put('apps.json', {
      [`github.com:${clientId}`]: { oauth_token: '' },
      'github.com:invalid': { oauth_token: 42 },
      [`other.example.test:${clientId}`]: { oauth_token: 'synthetic-other-host-token' },
    });
    await put('hosts.json', { 'github.com': { oauth_token: githubToken } });
    expect((await localSignIn().read(upstream().context, githubOptions)).credentials.githubToken).toBe(githubToken);
  });

  test('ignores an invalid preferred entry and selects a valid same-host app', async () => {
    await put('apps.json', {
      [`github.com:${clientId}`]: { oauth_token: '' },
      'github.com:other-app': { oauth_token: githubToken },
    });
    expect((await localSignIn().read(upstream().context, githubOptions)).credentials.githubToken).toBe(githubToken);
  });

  test.each(['apps.json', 'hosts.json'] as const)(
    'Enterprise options with only a github.com entry in %s fail without leaking its token',
    async (file) => {
      await put(file, {
        [file === 'apps.json' ? `github.com:${clientId}` : 'github.com']: { oauth_token: githubToken },
      });
      const { context, requests } = upstream();
      await expectSafeFailure(
        () =>
          localSignIn().read(context, { deploymentType: 'enterprise', enterpriseURL: 'https://company.example.test' }),
        [githubToken],
      );
      expect(requests).toEqual([]);
    },
  );

  test.each(['apps.json', 'hosts.json'] as const)(
    'selects the exact Enterprise host, including its port, from %s',
    async (file) => {
      const host = 'company.example.test:8443';
      const enterpriseURL = `https://${host}`;
      const entry = file === 'apps.json' ? `${host}:${clientId}` : host;
      await put(file, { [entry]: { oauth_token: githubToken } });
      const { context, requests } = upstream();
      const result = await localSignIn().read(context, { deploymentType: 'enterprise', enterpriseURL });
      expect(result.credentials.enterpriseURL).toBe(enterpriseURL);
      expect(result.fingerprint).toBe('4242');
      expect(requests.map((request) => request.url)).toEqual([
        `${enterpriseURL}/api/v3/copilot_internal/v2/token`,
        `${enterpriseURL}/api/v3/user`,
        `${enterpriseURL}/api/v3/user/emails`,
      ]);
      expect(requests.every((request) => request.authorization === `Bearer ${githubToken}`)).toBe(true);
    },
  );

  test.each([
    { deploymentType: 'github.com' },
    { deploymentType: 'enterprise', enterpriseURL: 'https://company.example.test' },
  ] as const)('does not reuse an apps.json token for a host with a different port (case %#)', async (options) => {
    const host = options.deploymentType === 'enterprise' ? new URL(options.enterpriseURL).host : 'github.com';
    await put('apps.json', { [`${host}:8443:${clientId}`]: { oauth_token: githubToken } });
    const { context, requests } = upstream();
    await expectSafeFailure(() => localSignIn().read(context, options), [githubToken]);
    expect(requests).toEqual([]);
  });

  test.each(['apps.json', 'hosts.json'] as const)('malformed JSON in %s fails cleanly', async (file) => {
    await Bun.write(join(dir, file), `{"oauth_token":"${githubToken}"`);
    const { context, requests } = upstream();
    await expectSafeFailure(() => localSignIn().read(context, githubOptions), [githubToken]);
    expect(requests).toEqual([]);
  });

  test.each(
    [
      null,
      [],
      {},
      { 'github.com': null },
      { 'github.com': [] },
      { 'github.com': { oauth_token: '' } },
      { 'github.com': { oauth_token: 42 } },
      { 'github.com': { oauth_token: ['synthetic-invalid-token'] } },
    ].map((value) => [value]),
  )('incomplete or non-object host stores fail cleanly (case %#)', async (value) => {
    await put('hosts.json', value);
    await expectSafeFailure(() => localSignIn().read(upstream().context, githubOptions), ['synthetic-invalid-token']);
  });

  test('missing stores fail cleanly when read is requested', async () => {
    await expectSafeFailure(() => localSignIn().read(upstream().context, githubOptions), []);
  });

  test('normalizes upstream errors carrying host credentials, including their causes', async () => {
    await put('hosts.json', { 'github.com': { oauth_token: githubToken } });
    await expectSafeFailure(
      () =>
        localSignIn().read(
          {
            signal,
            progress() {},
            fetch: async () => {
              throw new Error(githubToken, { cause: new Error(githubToken) });
            },
          },
          githubOptions,
        ),
      [githubToken],
    );
  });

  test('normalizes invalid upstream JSON without including host or Copilot tokens', async () => {
    await put('hosts.json', { 'github.com': { oauth_token: githubToken } });
    await expectSafeFailure(
      () =>
        localSignIn().read(
          {
            signal,
            progress() {},
            fetch: async () => new Response(`{"token":"${copilotToken}","secret":"${githubToken}"`),
          },
          githubOptions,
        ),
      [githubToken, copilotToken],
    );
  });

  test('result shape matches device-flow login with user id as fingerprint and leaves the store unchanged', async () => {
    await put('apps.json', { [`github.com:${clientId}`]: { user: 'untrusted-store-user', oauth_token: githubToken } });
    const before = await Bun.file(join(dir, 'apps.json')).text();
    const local = upstream();
    const result = await localSignIn().read(local.context, githubOptions);
    const device = await loginToGitHubCopilot(
      {
        ...upstream().context,
        authorization: {
          async presentDeviceCode() {},
          async presentAuthorizeUrl() {},
          async loopback() {
            throw new Error('Unexpected loopback');
          },
        },
      },
      githubOptions,
    );
    expect(result).toEqual(device);
    expect(result).toEqual({
      fingerprint: '4242',
      suggestedKey: 'copilot-4242',
      accountLabel: 'person@example.test',
      credentials: {
        githubToken,
        copilotToken,
        expiresAt: 9_999_999_999_000,
        baseURL: 'https://api.individual.githubcopilot.com',
      },
      expiresAt: 9_999_999_999_000,
    });
    expect(local.requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/copilot_internal/v2/token',
      '/user',
      '/user/emails',
    ]);
    expect(await Bun.file(join(dir, 'apps.json')).text()).toBe(before);
  });

  test('uses the upstream login as label when primary email is unavailable', async () => {
    await put('hosts.json', { 'github.com': { user: 'untrusted-store-user', oauth_token: githubToken } });
    const result = await localSignIn().read(upstream({ emailsAvailable: false }).context, githubOptions);
    expect(result.accountLabel).toBe('synthetic-user');
    expect(result.fingerprint).toBe('4242');
  });

  test('the registered plugin capability discovers and reads a synthetic XDG store without a write hook', async () => {
    await put('hosts.json', { 'github.com': { oauth_token: githubToken } });
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    try {
      let adapter: OAuthAdapter<GitHubAccountOptions, GitHubCopilotCredential> | undefined;
      await createGitHubCopilotPlugin(englishPresentationText).setup(
        {
          oauth: {
            register(value) {
              adapter = value as unknown as OAuthAdapter<GitHubAccountOptions, GitHubCopilotCredential>;
            },
          },
        },
        undefined,
      );
      const capability = adapter?.localSignIn;
      if (capability === undefined) throw new Error('Missing Copilot local sign-in capability');
      expect(capability.source).toBe('GitHub Copilot');
      expect(capability.write).toBeUndefined();
      expect(await capability.detect({ signal })).toBe(true);
      expect((await capability.read(upstream().context, githubOptions)).fingerprint).toBe('4242');
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
    }
  });
});
