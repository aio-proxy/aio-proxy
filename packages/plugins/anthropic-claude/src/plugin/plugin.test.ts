import { expect, test } from 'bun:test';

import type { OAuthAdapter, OAuthLoginContext, PluginDescriptor } from '@aio-proxy/plugin-sdk';

import claudePlugin, { CLAUDE_PLUGIN_VERSION, createAnthropicClaudePlugin } from '..';
import packageJson from '../../package.json' with { type: 'json' };
import { CLAUDE_CATALOG_TTL_MS } from '../catalog';
import { ClaudeIdentityMissingError, claudeLoginResult } from '../oauth';
import type { ClaudeCredential } from '../schema';

test('exports a versioned default descriptor with empty account options', async () => {
  const adapter = await adapterFrom(claudePlugin);
  expect(adapter.id).toBe('default');
  expect(claudePlugin.metadata.icon).toBe('anthropic');
  expect(adapter.account.options.form).toEqual([]);
  await expect(adapter.account.options.schema.parseAsync({})).resolves.toEqual({});
  expect(adapter.catalog.policy).toEqual({ kind: 'ttl', ttlMs: CLAUDE_CATALOG_TTL_MS });
  expect(adapter.quota).toBeUndefined();
  expect(CLAUDE_PLUGIN_VERSION).toBe(packageJson.version);
});

test('uses host loopback and localized adapter copy', async () => {
  const adapter = await adapterFrom(
    createAnthropicClaudePlugin(
      {
        adapterLabel: { default: 'Login with Claude', 'zh-Hans': '使用 Claude 登录' },
        waitingForAuthorization: { default: 'Waiting locally', 'zh-Hans': '正在本地等待' },
      },
      {
        now: () => 1_700_000_000_000,
        fetch: async () =>
          Response.json({
            access_token: 'access',
            refresh_token: 'refresh',
            expires_in: 3600,
            account: { uuid: 'acct', email_address: 'person@example.com' },
          }),
      },
    ),
  );
  const progress: unknown[] = [];
  const result = await adapter.login(
    {
      signal: new AbortController().signal,
      progress: (message) => progress.push(message),
      authorization: {
        presentDeviceCode: async () => {
          throw new Error('unexpected device-code');
        },
        presentAuthorizeUrl: async () => {
          throw new Error('unexpected presentAuthorizeUrl');
        },
        loopback: async (request) => {
          expect(request.redirect).toEqual({ hostname: 'localhost', port: 54545, path: '/callback' });
          expect(request.allowManualCallbackUrl).toBe(true);
          return { code: 'code', redirectUri: 'http://localhost:54545/callback' };
        },
      },
    } satisfies OAuthLoginContext,
    {},
  );
  expect(adapter.displayName).toEqual({ default: 'Login with Claude', 'zh-Hans': '使用 Claude 登录' });
  expect(progress).toEqual([{ default: 'Waiting locally', 'zh-Hans': '正在本地等待' }]);
  expect(result.credentials.accountId).toBe('acct');
});

test('imports CPA claude credentials with the same fingerprint rules', async () => {
  const adapter = await adapterFrom(createAnthropicClaudePlugin());
  const importer = adapter.credentialImports?.cpa;
  if (importer === undefined) throw new Error('CPA importer not registered');
  expect(importer.types).toEqual(['claude']);
  const context = { progress: () => {}, signal: new AbortController().signal };
  const imported = await importer.import(
    context,
    {},
    {
      type: 'claude',
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expired: '2026-08-24T12:00:00Z',
      email: 'Person@Example.com',
      account: { uuid: 'acct-1' },
      organization: { uuid: 'org-1', name: 'Team' },
      id_token: 'must-not-persist',
    },
  );
  const expected = claudeLoginResult({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: Date.parse('2026-08-24T12:00:00Z'),
    email: 'Person@Example.com',
    accountId: 'acct-1',
    organizationId: 'org-1',
    organizationName: 'Team',
  });
  expect(imported).toEqual(expected);
  expect(Object.keys(imported.credentials).toSorted()).toEqual([
    'accessToken',
    'accountId',
    'email',
    'expiresAt',
    'organizationId',
    'organizationName',
    'refreshToken',
  ]);
  const invalidExpiry = await importer.import(
    context,
    {},
    {
      type: 'claude',
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expired: 'invalid',
      email: 'person@example.com',
      account_uuid: 'acct-1',
    },
  );
  expect(invalidExpiry.expiresAt).toBe(0);
});

test('bootstraps a CPA file that omits accountId when import context has no fetch', async () => {
  const adapter = await adapterFrom(
    createAnthropicClaudePlugin(undefined, {
      fetch: async () =>
        Response.json({
          oauth_account: {
            account_uuid: 'boot-acct',
            account_email: 'boot@example.com',
          },
        }),
    }),
  );
  const importer = adapter.credentialImports?.cpa;
  if (importer === undefined) throw new Error('CPA importer not registered');
  const imported = await importer.import(
    { progress: () => {}, signal: new AbortController().signal },
    {},
    { type: 'claude', access_token: 'access-1', refresh_token: 'refresh-1' },
  );
  expect(imported.credentials.accountId).toBe('boot-acct');
  expect(imported.credentials.email).toBe('boot@example.com');
});

test('rejects CPA files that still have no accountId after bootstrap', async () => {
  const adapter = await adapterFrom(
    createAnthropicClaudePlugin(undefined, {
      fetch: async () => new Response('nope', { status: 500 }),
    }),
  );
  const importer = adapter.credentialImports?.cpa;
  if (importer === undefined) throw new Error('CPA importer not registered');
  await expect(
    importer.import(
      {
        progress: () => {},
        signal: new AbortController().signal,
        fetch: async () => new Response('nope', { status: 500 }),
      },
      {},
      { type: 'claude', access_token: 'access-1', refresh_token: 'refresh-1', email: 'person@example.com' },
    ),
  ).rejects.toBeInstanceOf(ClaudeIdentityMissingError);
});

test('imports flat CPA claude files using account_uuid aliases', async () => {
  const adapter = await adapterFrom(createAnthropicClaudePlugin());
  const importer = adapter.credentialImports?.cpa;
  if (importer === undefined) throw new Error('CPA importer not registered');
  const imported = await importer.import(
    { progress: () => {}, signal: new AbortController().signal },
    {},
    {
      type: 'claude',
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      expired: '2026-08-24T12:00:00Z',
      email: 'Person@Example.com',
      account_uuid: 'acct-2',
      organization_uuid: 'org-2',
      organization_name: 'Team',
      claude_device_ids: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      id_token: 'must-not-persist',
    },
  );
  expect(imported).toEqual(
    claudeLoginResult({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      expiresAt: Date.parse('2026-08-24T12:00:00Z'),
      email: 'Person@Example.com',
      accountId: 'acct-2',
      organizationId: 'org-2',
      organizationName: 'Team',
    }),
  );
  expect(Object.keys(imported.credentials).toSorted()).toEqual([
    'accessToken',
    'accountId',
    'email',
    'expiresAt',
    'organizationId',
    'organizationName',
    'refreshToken',
  ]);
});

test('refreshCredential exchanges an unexpired credential instead of returning it unchanged', async () => {
  let exchanges = 0;
  const adapter = await adapterFrom(
    createAnthropicClaudePlugin(undefined, {
      now: () => 1_000,
      fetch: async () => {
        exchanges += 1;
        return Response.json({ access_token: 'new-access', expires_in: 60 });
      },
    }),
  );
  const credential: ClaudeCredential = {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: Number.MAX_SAFE_INTEGER,
    email: 'person@example.com',
    accountId: 'acct',
  };
  const result = await adapter.refreshCredential!({
    credential,
    options: {},
    signal: new AbortController().signal,
  });
  expect(exchanges).toBe(1);
  expect(result.value.accessToken).toBe('new-access');
  expect(result.value.refreshToken).toBe('old-refresh');
  expect(result.value.expiresAt).toBe(1_000 + 60_000 - 5 * 60_000);
  expect(result.metadata).toEqual({ expiresAt: result.value.expiresAt, accountLabel: 'person@example.com' });
});

async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<Record<string, never>, ClaudeCredential>> {
  let registered: OAuthAdapter<Record<string, never>, ClaudeCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(adapter) {
          registered = adapter as OAuthAdapter<Record<string, never>, ClaudeCredential>;
        },
      },
    },
    undefined,
  );
  if (registered === undefined) throw new Error('Claude OAuth adapter was not registered');
  return registered;
}
