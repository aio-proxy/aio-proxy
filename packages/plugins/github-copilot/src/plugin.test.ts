import { describe, expect, test } from 'bun:test';

import type { OAuthAdapter, PluginDescriptor, RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import githubCopilotPlugin, {
  COPILOT_CATALOG_TTL_MS,
  GITHUB_COPILOT_PLUGIN_VERSION,
  type GitHubAccountOptions,
  type GitHubCopilotCredential,
} from '.';
import { credentialPort, deviceFlowFetch, loginContext, withFetchMock } from '../__tests__/test-support';
import packageJson from '../package.json' with { type: 'json' };
import { createGitHubCopilotPlugin } from './plugin';

describe('GitHub Copilot plugin', () => {
  test('exports a versioned default descriptor that registers OAuth capability default', async () => {
    const adapter = await adapterFrom(githubCopilotPlugin);

    expect(githubCopilotPlugin.metadata.icon).toBe('githubcopilot');
    expect(adapter.id).toBe('default');
    expect(adapter.displayName).toBe('Login with GitHub Copilot');
    expect(GITHUB_COPILOT_PLUGIN_VERSION).toBe(packageJson.version);
  });

  test('exposes account options for GitHub.com and a conditional Enterprise URL', async () => {
    const adapter = await adapterFrom(githubCopilotPlugin);

    expect(adapter.account.options.form).toEqual([
      {
        type: 'select',
        key: 'deploymentType',
        label: 'Select GitHub deployment type',
        options: [
          { value: 'github.com', label: 'GitHub.com' },
          { value: 'enterprise', label: 'GitHub Enterprise' },
        ],
      },
      {
        type: 'text',
        key: 'enterpriseURL',
        label: 'Enter your GitHub Enterprise URL or domain',
        placeholder: 'company.ghe.com or https://company.ghe.com',
        when: { key: 'deploymentType', equals: 'enterprise' },
      },
    ]);
    await expect(adapter.account.options.schema.parseAsync({})).resolves.toEqual({ deploymentType: 'github.com' });
    await expect(
      adapter.account.options.schema.parseAsync({
        deploymentType: 'enterprise',
        enterpriseURL: ' https://company.ghe.com/path ',
      }),
    ).resolves.toEqual({ deploymentType: 'enterprise', enterpriseURL: 'https://company.ghe.com' });
  });

  test('rejects an invalid Enterprise domain before fetching', async () => {
    const adapter = await adapterFrom(githubCopilotPlugin);
    let fetched = false;

    await withFetchMock(
      async () => {
        fetched = true;
        return Response.json({});
      },
      async () => {
        await expect(
          adapter.login(loginContext(), {
            deploymentType: 'enterprise',
            enterpriseURL: 'not a host name',
          }),
        ).rejects.toThrow('GitHub Enterprise URL or domain is required');
      },
    );

    expect(fetched).toBe(false);
  });

  test('supports injectable localized account copy', async () => {
    const adapter = await adapterFrom(
      createGitHubCopilotPlugin({
        adapterLabel: 'Copilote GitHub',
        deploymentTypeLabel: 'Déploiement GitHub',
        githubDotComLabel: 'GitHub public',
        enterpriseLabel: 'GitHub Entreprise',
        enterpriseURLLabel: 'Domaine GitHub Entreprise',
        enterpriseURLPlaceholder: 'entreprise.example',
      }),
    );

    expect(adapter.displayName).toBe('Copilote GitHub');
    expect(adapter.account.options.form[0]?.label).toBe('Déploiement GitHub');
    expect(adapter.account.options.form[1]?.label).toBe('Domaine GitHub Entreprise');
  });

  test('supports injectable localized login progress copy', async () => {
    const adapter = await adapterFrom(
      createGitHubCopilotPlugin({
        adapterLabel: 'Copilote GitHub',
        deploymentTypeLabel: 'Déploiement GitHub',
        githubDotComLabel: 'GitHub public',
        enterpriseLabel: 'GitHub Entreprise',
        enterpriseURLLabel: 'Domaine GitHub Entreprise',
        enterpriseURLPlaceholder: 'entreprise.example',
        refreshingToken: 'Actualisation du jeton GitHub Copilot',
        waitingForAuthorization: 'En attente de l’autorisation GitHub',
      }),
    );
    const progress: unknown[] = [];

    await withFetchMock(
      deviceFlowFetch({ tokenResponses: [{ error: 'authorization_pending' }, { access_token: 'github-token' }] }),
      () =>
        adapter.login(loginContext({ progress: (message) => progress.push(message) }), {
          deploymentType: 'github.com',
        }),
    );

    expect(progress).toEqual(['En attente de l’autorisation GitHub', 'Actualisation du jeton GitHub Copilot']);
  });

  test('credential parsing omits an absent Enterprise URL', async () => {
    const adapter = await adapterFrom(githubCopilotPlugin);
    const credential = await adapter.credentials.parseAsync({
      githubToken: 'github-token',
      copilotToken: 'copilot-token',
      expiresAt: 1,
      baseURL: 'https://api.githubcopilot.com',
      enterpriseURL: undefined,
    });

    expect('enterpriseURL' in credential).toBe(false);
  });

  test('credential parsing rejects an invalid Copilot base URL', async () => {
    const adapter = await adapterFrom(githubCopilotPlugin);

    await expect(
      adapter.credentials.parseAsync({
        githubToken: 'github-token',
        copilotToken: 'copilot-token',
        expiresAt: 1,
        baseURL: 'not a URL',
      }),
    ).rejects.toThrow();
  });

  test('uses the catalog-owned six-hour TTL policy', async () => {
    const adapter = await adapterFrom(githubCopilotPlugin);

    expect(COPILOT_CATALOG_TTL_MS).toBe(6 * 60 * 60_000);
    expect(adapter.catalog.policy).toEqual({ kind: 'ttl', ttlMs: COPILOT_CATALOG_TTL_MS });
  });

  test('refreshCredential exchanges an unexpired credential instead of returning it unchanged', async () => {
    const adapter = await adapterFrom(githubCopilotPlugin);
    let exchanges = 0;
    const result = await withFetchMock(
      async (input) => {
        expect(new URL(String(input)).pathname).toBe('/copilot_internal/v2/token');
        exchanges += 1;
        return Response.json({
          token: 'tid=x;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;',
          expires_at: 9_999_999_999,
        });
      },
      async () =>
        await adapter.refreshCredential!({
          credential: {
            githubToken: 'github-token',
            copilotToken: 'stale-copilot-token',
            expiresAt: Number.MAX_SAFE_INTEGER,
            baseURL: 'https://api.githubcopilot.com',
          },
          options: { deploymentType: 'github.com' },
          signal: new AbortController().signal,
        }),
    );

    expect(exchanges).toBe(1);
    expect(result.value).toEqual({
      githubToken: 'github-token',
      copilotToken: 'tid=x;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;',
      expiresAt: 9_999_999_999_000,
      baseURL: 'https://api.individual.githubcopilot.com',
    });
    expect(result.metadata).toEqual({ expiresAt: 9_999_999_999_000 });
  });

  test('reads quota through the host fetch and offers no reset', async () => {
    const adapter = await adapterFrom(githubCopilotPlugin);
    const quota = adapter.quota;
    if (quota === undefined) throw new Error('missing GitHub Copilot quota capability');
    const requests: RuntimeRequestInit[] = [];

    // No `withFetchMock` here on purpose: the capability has to reach upstream through the injected
    // host fetch, which is what tags the call as control traffic and applies the Provider's proxy.
    const snapshot = await quota.read({
      credentials: credentialPort({
        githubToken: 'github-token',
        copilotToken: 'copilot-token',
        expiresAt: 0,
        baseURL: 'https://api.githubcopilot.com',
      }).port,
      options: { deploymentType: 'github.com' },
      signal: new AbortController().signal,
      fetch: (async (_input: RequestInfo | URL, init?: RuntimeRequestInit) => {
        requests.push(init ?? {});
        return Response.json({ copilot_plan: 'pro', quota_snapshots: { chat: { percent_remaining: 40 } } });
      }) as RuntimeFetch,
    });

    expect(quota.reset).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.aioProxy).toEqual({ traffic: 'control' });
    expect(snapshot).toEqual({
      items: [{ id: 'chat', displayName: { default: 'Chat', 'zh-Hans': '聊天' }, remainingRatio: 0.4 }],
      plan: 'Pro',
    });
  });
});

async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<GitHubAccountOptions, GitHubCopilotCredential>> {
  let registered: OAuthAdapter<GitHubAccountOptions, GitHubCopilotCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(adapter) {
          registered = adapter as unknown as OAuthAdapter<GitHubAccountOptions, GitHubCopilotCredential>;
        },
      },
    },
    undefined,
  );
  if (registered === undefined) throw new Error('GitHub Copilot OAuth adapter was not registered');
  return registered;
}
