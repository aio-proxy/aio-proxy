import { expect, test } from 'bun:test';

import type { CredentialPort } from '@aio-proxy/plugin-sdk';

import { readXAIGrokQuota } from './quota';
import type { XAIGrokCredential } from './schema';

test('reads weekly and monthly Grok billing through the CLI proxy', async () => {
  const requests: Request[] = [];
  const snapshot = await readXAIGrokQuota(context(), {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith('?format=credits')) {
        return Response.json({
          config: {
            currentPeriod: { type: 'weekly', end: '2027-01-15T00:00:00Z' },
            creditUsagePercent: '25',
          },
        });
      }
      return Response.json({
        config: {
          monthlyLimit: { val: '10000' },
          used: { val: 2500 },
          billingPeriodEnd: '2027-02-01T00:00:00Z',
        },
      });
    },
  });

  expect(requests.map(({ url }) => url).toSorted()).toEqual([
    'https://cli-chat-proxy.grok.com/v1/billing',
    'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
    'https://cli-chat-proxy.grok.com/v1/settings',
  ]);
  for (const request of requests) {
    expect(request.method).toBe('GET');
    expect(request.headers.get('authorization')).toBe('Bearer access-token');
    expect(request.headers.get('x-xai-token-auth')).toBe('xai-grok-cli');
    expect(request.headers.get('x-grok-client-version')).toBe('0.2.120');
    expect(request.headers.get('x-grok-client-identifier')).toBe('grok-shell');
    expect(request.headers.get('x-authenticateresponse')).toBe('authenticate-response');
    expect(request.headers.get('user-agent')).toBe('xai-grok-workspace/0.2.120');
    expect(request.headers.get('x-userid')).toBe('user-123');
  }
  expect(snapshot).toEqual({
    items: [
      {
        id: 'weekly',
        displayName: { default: 'Weekly limit', 'zh-Hans': '周额度' },
        remainingRatio: 0.75,
        resetsAt: Date.parse('2027-01-15T00:00:00Z'),
      },
      {
        id: 'monthly-credits',
        displayName: { default: 'Monthly credits', 'zh-Hans': '月度额度' },
        remainingRatio: 0.75,
        resetsAt: Date.parse('2027-02-01T00:00:00Z'),
      },
    ],
  });
});

test('keeps valid monthly quota when weekly billing fails', async () => {
  const snapshot = await readXAIGrokQuota(context(), {
    fetch: async (input) => {
      if (new URL(input.toString()).searchParams.has('format')) return new Response(null, { status: 503 });
      return Response.json({
        config: {
          monthly_limit: { val: 100 },
          used: { val: 140 },
          billing_period_end: '2027-02-01T00:00:00Z',
        },
      });
    },
  });

  expect(snapshot.items).toEqual([
    {
      id: 'monthly-credits',
      displayName: { default: 'Monthly credits', 'zh-Hans': '月度额度' },
      remainingRatio: 0,
      resetsAt: Date.parse('2027-02-01T00:00:00Z'),
    },
  ]);
});

test('fails quota read when neither billing endpoint returns quota', async () => {
  await expect(readXAIGrokQuota(context(), { fetch: async () => new Response(null, { status: 503 }) })).rejects.toThrow(
    'xAI Grok billing request failed',
  );
});

test('reports the subscription tier as the plan', async () => {
  const snapshot = await readWithResponses({
    settings: { subscription_tier_display: 'SuperGrok Heavy' },
  });
  expect(snapshot.plan).toBe('SuperGrok Heavy');
});

test('drops the plan when settings fail without failing the read', async () => {
  const snapshot = await readWithResponses({ settings: new Error('offline') });
  expect(snapshot).not.toHaveProperty('plan');
  expect(snapshot.items.length).toBeGreaterThan(0);
});

test('keeps the weekly window when a unified-billing account reports no usage percent', async () => {
  const snapshot = await readWithResponses({
    weekly: { config: { currentPeriod: { end: '2026-09-08T00:00:00.000Z' } } },
  });
  const weekly = snapshot.items.find((item) => item.id === 'weekly');
  expect(weekly).toBeDefined();
  expect(weekly).not.toHaveProperty('remainingRatio');
  expect(weekly?.resetsAt).toBe(Date.parse('2026-09-08T00:00:00.000Z'));
});

test('maps per-product usage into its own items with normalized ids', async () => {
  const snapshot = await readWithResponses({
    weekly: {
      config: {
        creditUsagePercent: 10,
        currentPeriod: { end: '2026-09-08T00:00:00.000Z' },
        productUsage: [
          { product: 'productgrokbuild', usagePercent: 25 },
          { product: 'Grok Code', usagePercent: 40 },
          { product: 'grokbuild', usagePercent: 60 },
        ],
      },
    },
  });
  const ids = snapshot.items.map((item) => item.id);
  expect(ids).toContain('product_grok_build');
  expect(ids).toContain('product_grok_code');
  expect(ids).toContain('product_grok_build_2');
  const build = snapshot.items.find((item) => item.id === 'product_grok_build');
  expect(build?.remainingRatio).toBeCloseTo(0.75, 5);
  expect(build?.displayName).toBe('Grok Build');
});

test('a product spelling that collides with a generated suffix still yields unique ids', async () => {
  // `grok build 2` normalizes to the very id the deduplicator hands the second `grok build`. Two
  // items sharing an id make the core validator reject the whole snapshot, so the ring would go dark
  // for an account whose billing response is otherwise perfectly usable.
  const snapshot = await readWithResponses({
    weekly: {
      config: {
        creditUsagePercent: 10,
        currentPeriod: { end: '2026-09-08T00:00:00.000Z' },
        productUsage: [
          { product: 'grok build', usagePercent: 10 },
          { product: 'grok build 2', usagePercent: 20 },
          { product: 'grokbuild', usagePercent: 30 },
        ],
      },
    },
  });

  const ids = snapshot.items.map((item) => item.id);
  expect(new Set(ids).size).toBe(ids.length);
});

type Leg = Record<string, unknown> | Error;

const DEFAULT_WEEKLY = {
  config: { currentPeriod: { type: 'weekly', end: '2027-01-15T00:00:00Z' }, creditUsagePercent: '25' },
};
const DEFAULT_MONTHLY = {
  config: { monthlyLimit: { val: '10000' }, used: { val: 2500 }, billingPeriodEnd: '2027-02-01T00:00:00Z' },
};
const DEFAULT_SETTINGS = { subscription_tier_display: 'SuperGrok' };

async function readWithResponses(overrides: { weekly?: Leg; monthly?: Leg; settings?: Leg } = {}) {
  const leg = (value: Leg | undefined, fallback: Record<string, unknown>) => {
    if (value instanceof Error) throw value;
    return Response.json(value ?? fallback);
  };
  return readXAIGrokQuota(context(), {
    fetch: async (input) => {
      const url = input.toString();
      if (url.endsWith('/settings')) return leg(overrides.settings, DEFAULT_SETTINGS);
      if (url.endsWith('?format=credits')) return leg(overrides.weekly, DEFAULT_WEEKLY);
      return leg(overrides.monthly, DEFAULT_MONTHLY);
    },
  });
}

function context() {
  return { credentials: port(), options: {}, signal: new AbortController().signal };
}

function port(): CredentialPort<XAIGrokCredential> {
  return {
    read: async () => ({
      revision: 1,
      value: {
        accessToken: 'access-token',
        refreshToken: 'refresh',
        expiresAt: 1_900_000_000_000,
        subject: 'user-123',
      },
    }),
    refresh: async () => {
      throw new Error('fresh credential must not refresh');
    },
  };
}
