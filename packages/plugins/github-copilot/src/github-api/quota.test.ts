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

  // Per-entry parsing is lossy on purpose: an entry nothing can be derived from is dropped, and one
  // unusable sibling must never discard the windows that did parse. Every emitted item carries a
  // `remainingRatio` — a ratio-less item survives snapshot validation but renders no meter at all.
  test('drops entries no ratio can be derived from and keeps their siblings', async () => {
    const { fetcher } = usageFetcher({
      quota_snapshots: {
        good: { percent_remaining: 40 },
        no_percent: { entitlement: 10 },
        broken: 'nope',
      },
    });

    const snapshot = await readGitHubCopilotQuota(context(), fetcher);

    // `toStrictEqual`, not `toEqual`: `toEqual` treats a trailing `undefined` element as absent, so a
    // `flatMap` weakened to `map` would leave this green while emitting holes the validator throws on.
    expect(snapshot.items).toStrictEqual([{ id: 'good', displayName: 'Good', remainingRatio: 0.4 }]);
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

  // An unlimited allowance has no denominator, and GitHub's zero/zero placeholder for token-based
  // billing is sometimes served as `percent_remaining: 100`. Showing either as a full bar would tell
  // the user a seat is healthy when it is simply not metered.
  test('reports an unmetered seat as a successful empty snapshot', async () => {
    const { fetcher } = usageFetcher({
      copilot_plan: 'free',
      quota_snapshots: {
        premium_interactions: { unlimited: true, percent_remaining: 100 },
        chat: { entitlement: 0, remaining: 0, percent_remaining: 100 },
        // `remaining` is optional upstream, and an entitlement of 0 is already a complete statement
        // that the window has no denominator — the 100% must not survive as a confident full bar.
        completions: { entitlement: 0, percent_remaining: 100 },
        // `unlimited` is only trustworthy as a claim, not as a boolean: anything present and not
        // `false` still says unlimited.
        spark_premium_request: { unlimited: 'true', percent_remaining: 100 },
      },
    });

    const snapshot = await readGitHubCopilotQuota(context(), fetcher);

    expect(snapshot).toEqual({ items: [], plan: 'Free' });
  });

  test('derives a missing percentage and clamps an over-quota window to empty', async () => {
    const { fetcher } = usageFetcher({
      quota_snapshots: {
        premium_interactions: { percent_remaining: -20 },
        chat: { entitlement: 200, remaining: 50 },
      },
    });

    const snapshot = await readGitHubCopilotQuota(context(), fetcher);

    expect(snapshot.items.map((item) => [item.id, item.remainingRatio])).toEqual([
      ['premium_interactions', 0],
      ['chat', 0.25],
    ]);
  });

  test('keeps an unfamiliar window when a sibling entry is malformed', async () => {
    const { fetcher } = usageFetcher({
      copilot_plan: 'unknown',
      quota_snapshots: { spark_premium_request: { percent_remaining: 40 }, chat: 'nope' },
    });

    const snapshot = await readGitHubCopilotQuota(context(), fetcher);

    expect(snapshot.items).toEqual([
      { id: 'spark_premium_request', displayName: 'Spark Premium Request', remainingRatio: 0.4 },
    ]);
    // `unknown` is GitHub's "no answer", not a tier. Showing it would put a literal "Unknown" under
    // the Provider name.
    expect(snapshot.plan).toBeUndefined();
  });

  // Free and older seats answer with counters instead of snapshots. A duplicate id would make the
  // core validator reject the whole snapshot, so `chat` must not come back twice.
  test('falls back to the monthly counters for windows the snapshots do not cover', async () => {
    const { fetcher } = usageFetcher({
      quota_snapshots: { chat: { percent_remaining: 25 } },
      monthly_quotas: { chat: 50, completions: 2000 },
      limited_user_quotas: { chat: 20, completions: 500 },
    });

    const snapshot = await readGitHubCopilotQuota(context(), fetcher);

    expect(snapshot.items).toEqual([
      { id: 'chat', displayName: { default: 'Chat', 'zh-Hans': '聊天' }, remainingRatio: 0.25 },
      {
        id: 'completions',
        displayName: { default: 'Code completions', 'zh-Hans': '代码补全' },
        remainingRatio: 0.25,
      },
    ]);
  });

  // The counters must not resurrect a window the snapshots deliberately suppressed: an unlimited
  // seat that also reports legacy counters would otherwise render a bar the snapshot said not to.
  test('keeps an unlimited window suppressed when the counters also report it', async () => {
    const { fetcher } = usageFetcher({
      copilot_plan: 'free',
      quota_snapshots: { chat: { unlimited: true } },
      monthly_quotas: { chat: 50 },
      limited_user_quotas: { chat: 20 },
    });

    const snapshot = await readGitHubCopilotQuota(context(), fetcher);

    expect(snapshot).toStrictEqual({ items: [], plan: 'Free' });
  });

  test('keeps a zero/zero window suppressed when the counters also report it', async () => {
    const { fetcher } = usageFetcher({
      quota_snapshots: {
        chat: { entitlement: 0, remaining: 0, percent_remaining: 100 },
        // The widened suppression has to reach the counters too: a window dropped as unmetered that
        // reappears at a counter-derived percentage is the same misleading bar by another route.
        completions: { entitlement: 0, percent_remaining: 100 },
        spark_premium_request: { unlimited: 'true' },
      },
      monthly_quotas: { chat: 50, completions: 2000, spark_premium_request: 10 },
      limited_user_quotas: { chat: 20, completions: 500, spark_premium_request: 4 },
    });

    const snapshot = await readGitHubCopilotQuota(context(), fetcher);

    expect(snapshot.items).toStrictEqual([]);
  });

  // Two payload keys can trim into one id, and the core validator rejects a duplicate id by throwing
  // out the whole snapshot — the "one bad entry must not discard its siblings" rule, from the other
  // direction. First key wins; a key that trims to nothing was never an id at all.
  test('keeps the first of two keys that trim to the same id', async () => {
    const { fetcher } = usageFetcher({
      quota_snapshots: {
        chat: { percent_remaining: 50 },
        ' chat': { percent_remaining: 10 },
        '  ': { percent_remaining: 90 },
      },
    });

    const snapshot = await readGitHubCopilotQuota(context(), fetcher);

    expect(snapshot.items).toStrictEqual([
      { id: 'chat', displayName: { default: 'Chat', 'zh-Hans': '聊天' }, remainingRatio: 0.5 },
    ]);
  });

  // The mirror of the two above: a snapshot entry nothing can be read from is "no answer", not
  // "unmetered", so the counters are still allowed to speak for that window.
  test('falls back to the counters when the snapshot entry is unreadable', async () => {
    const { fetcher } = usageFetcher({
      quota_snapshots: { chat: 'nope' },
      monthly_quotas: { chat: 50 },
      limited_user_quotas: { chat: 20 },
    });

    const snapshot = await readGitHubCopilotQuota(context(), fetcher);

    expect(snapshot.items).toStrictEqual([
      { id: 'chat', displayName: { default: 'Chat', 'zh-Hans': '聊天' }, remainingRatio: 0.4 },
    ]);
  });
});
