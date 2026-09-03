import { describe, expect, test } from 'bun:test';

import type { AccountContext, RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { type GitHubAccountOptions, type GitHubCopilotCredential, readGitHubCopilotQuota } from '.';
import { credentialPort } from '../../__tests__/test-support';

// `expiresAt: 0` on purpose: the quota read wants the long-lived GitHub token, so it must not take
// the credential-refresh path. The stub fetcher below would see the extra token request if it did.
const credential: GitHubCopilotCredential = {
  githubToken: 'github-token',
  copilotToken: 'copilot-token',
  expiresAt: 0,
  baseURL: 'https://api.githubcopilot.com',
};

function context(
  overrides: Partial<GitHubCopilotCredential> = {},
): AccountContext<GitHubCopilotCredential, GitHubAccountOptions> {
  return {
    credentials: credentialPort({ ...credential, ...overrides }).port,
    options: { deploymentType: 'github.com' },
    signal: new AbortController().signal,
  };
}

function usageFetcher(payload: unknown, status = 200) {
  const calls: { readonly url: string; readonly headers: Headers; readonly init: RuntimeRequestInit }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RuntimeRequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), init: init ?? {} });
    return status === 200 ? Response.json(payload) : new Response('denied', { status });
  }) as RuntimeFetch;
  return { fetcher, calls };
}

describe('GitHub Copilot quota', () => {
  test('maps each reported window and the monthly reset date', async () => {
    const { fetcher } = usageFetcher({
      copilot_plan: 'copilot_business',
      quota_reset_date: '2026-10-01',
      quota_snapshots: {
        premium_interactions: { entitlement: 300, remaining: 210, percent_remaining: 70 },
        chat: { entitlement: 100, remaining: 5, percent_remaining: 5 },
      },
    });

    const snapshot = await readGitHubCopilotQuota(context(), fetcher);

    expect(snapshot).toEqual({
      items: [
        {
          id: 'premium_interactions',
          displayName: { default: 'Premium requests', 'zh-Hans': '高级请求' },
          remainingRatio: 0.7,
          resetsAt: Date.parse('2026-10-01'),
        },
        {
          id: 'chat',
          displayName: { default: 'Chat', 'zh-Hans': '聊天' },
          remainingRatio: 0.05,
          resetsAt: Date.parse('2026-10-01'),
        },
      ],
      plan: 'Copilot Business',
    });
  });

  test('reads copilot_internal/user once, as control traffic, with the GitHub OAuth token', async () => {
    const { fetcher, calls } = usageFetcher({ copilot_plan: 'free' });

    await readGitHubCopilotQuota(context(), fetcher);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.github.com/copilot_internal/user');
    expect(calls[0]?.headers.get('authorization')).toBe('token github-token');
    expect(calls[0]?.headers.get('x-github-api-version')).toBe('2025-04-01');
    expect(calls[0]?.init.aioProxy).toEqual({ traffic: 'control' });
  });

  test('reads an Enterprise deployment through the REST base the plugin already uses', async () => {
    const { fetcher, calls } = usageFetcher({ copilot_plan: 'free' });

    await readGitHubCopilotQuota(context({ enterpriseURL: 'https://company.ghe.com' }), fetcher);

    expect(calls[0]?.url).toBe('https://company.ghe.com/api/v3/copilot_internal/user');
  });

  test('fails when the usage request is rejected', async () => {
    const { fetcher } = usageFetcher(undefined, 401);

    await expect(readGitHubCopilotQuota(context(), fetcher)).rejects.toThrow('GitHub Copilot request failed (401)');
  });
});
