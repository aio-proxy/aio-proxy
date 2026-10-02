import { describe, expect, test } from 'bun:test';

import type { RouterCandidate } from '@aio-proxy/core';
import type { OAuthQuotaItem } from '@aio-proxy/plugin-sdk';
import { ProviderKind } from '@aio-proxy/types';

import type { OAuthQuotaCacheStatus } from '../../../plugin-quota';
import type { RuntimeProviderInstance } from '../../../runtime';
import { ProviderCooldownStore } from '../provider-cooldown';
import { candidateHold, QUOTA_SNAPSHOT_MAX_AGE_MS, quotaHeldUntil, quotaScopeCovers } from './quota-gate';

const now = 1_000_000_000;

function ready(
  items: readonly OAuthQuotaItem[],
  { sampledAt = now - 1_000, stale = false }: { readonly sampledAt?: number; readonly stale?: boolean } = {},
): OAuthQuotaCacheStatus {
  return { kind: 'ready', entry: { snapshot: { items }, sampledAt, stale } };
}

function exhausted(resetsAt: number, scope: OAuthQuotaItem['scope'] = 'account'): OAuthQuotaItem {
  return { id: `window-${resetsAt}`, displayName: 'Window', remainingRatio: 0, resetsAt, scope };
}

describe('quotaScopeCovers', () => {
  test('an account scope covers every model', () => {
    expect(quotaScopeCovers('account', 'anything')).toBe(true);
  });

  test('patterns match case-insensitively with * wildcards', () => {
    expect(quotaScopeCovers({ models: ['gpt-*'] }, 'GPT-5')).toBe(true);
    expect(quotaScopeCovers({ models: ['gpt-*'] }, 'o3')).toBe(false);
    expect(quotaScopeCovers({ models: ['anthropic/*'] }, 'anthropic/claude')).toBe(true);
  });

  test('an exclusion removes a model the inclusions would cover', () => {
    const scope = { models: ['*', '!gpt-reserve'] };
    expect(quotaScopeCovers(scope, 'gpt-5')).toBe(true);
    expect(quotaScopeCovers(scope, 'gpt-reserve')).toBe(false);
  });

  test('exclusions alone cover nothing', () => {
    expect(quotaScopeCovers({ models: ['!x'] }, 'y')).toBe(false);
  });

  test('regex metacharacters in a pattern are literal', () => {
    expect(quotaScopeCovers({ models: ['gpt-5.1'] }, 'gpt-5x1')).toBe(false);
    expect(quotaScopeCovers({ models: ['gpt-5.1'] }, 'gpt-5.1')).toBe(true);
  });
});

describe('quotaHeldUntil', () => {
  test('holds a candidate whose account window is exhausted until it resets', () => {
    expect(quotaHeldUntil(ready([exhausted(now + 60_000)]), 'm', now)).toBe(now + 60_000);
  });

  test('ignores an exhausted window that declares no scope', () => {
    const item: OAuthQuotaItem = { id: 'w', displayName: 'W', remainingRatio: 0, resetsAt: now + 60_000 };
    expect(quotaHeldUntil(ready([item]), 'm', now)).toBeUndefined();
  });

  test('ignores an exhausted window whose scope does not cover the model', () => {
    expect(quotaHeldUntil(ready([exhausted(now + 60_000, { models: ['other-*'] })]), 'm', now)).toBeUndefined();
  });

  test.each([
    ['quota remains', { remainingRatio: 0.01, resetsAt: now + 60_000 }],
    ['the ratio is unknown', { resetsAt: now + 60_000 }],
    ['the reset time is unknown', { remainingRatio: 0 }],
    ['the reset already passed', { remainingRatio: 0, resetsAt: now }],
  ])('does not hold when %s', (_name, fields) => {
    const item: OAuthQuotaItem = { id: 'w', displayName: 'W', scope: 'account', ...fields };
    expect(quotaHeldUntil(ready([item]), 'm', now)).toBeUndefined();
  });

  test('holds until the latest reset among covering exhausted windows', () => {
    expect(quotaHeldUntil(ready([exhausted(now + 60_000), exhausted(now + 120_000)]), 'm', now)).toBe(now + 120_000);
  });

  test('a snapshot whose last read failed never holds', () => {
    expect(quotaHeldUntil(ready([exhausted(now + 60_000)], { stale: true }), 'm', now)).toBeUndefined();
  });

  test('a snapshot older than the max age never holds', () => {
    const old = ready([exhausted(now + 60_000)], { sampledAt: now - QUOTA_SNAPSHOT_MAX_AGE_MS - 1 });
    expect(quotaHeldUntil(old, 'm', now)).toBeUndefined();
    const edge = ready([exhausted(now + 60_000)], { sampledAt: now - QUOTA_SNAPSHOT_MAX_AGE_MS });
    expect(quotaHeldUntil(edge, 'm', now)).toBe(now + 60_000);
  });

  test.each(['none', 'loading', 'failed', 'unsupported'] as const)('an unread (%s) quota never holds', (kind) => {
    expect(quotaHeldUntil({ kind }, 'm', now)).toBeUndefined();
  });
});

describe('candidateHold', () => {
  const candidate = (kind: string) =>
    ({ provider: { id: 'p', kind }, modelId: 'm' }) as unknown as RouterCandidate<RuntimeProviderInstance>;

  function source(cooldownMs: number, status: OAuthQuotaCacheStatus) {
    const cooldown = new ProviderCooldownStore();
    cooldown.cool('p', 'm', cooldownMs);
    const warmed: string[] = [];
    return {
      warmed,
      source: { cooldown, quotaStatus: () => status, warmProviderQuota: (id: string) => warmed.push(id) },
    };
  }

  test('a candidate both cooling and exhausted is held for the longer of the two', () => {
    const quotaLonger = source(30_000, ready([exhausted(now + 3_600_000)]));
    expect(candidateHold(quotaLonger.source, candidate(ProviderKind.OAuth), now)).toEqual({
      reason: 'quota_exhausted',
      remainingMs: 3_600_000,
    });
    const cooldownLonger = source(30_000, ready([exhausted(now + 10_000)]));
    expect(candidateHold(cooldownLonger.source, candidate(ProviderKind.OAuth), now)?.reason).toBe('cooldown');
  });

  test('warms only a subscription that quota holds', () => {
    const held = source(0, ready([exhausted(now + 60_000)]));
    candidateHold(held.source, candidate(ProviderKind.OAuth), now);
    expect(held.warmed).toEqual(['p']);
    const open = source(0, { kind: 'none' });
    expect(candidateHold(open.source, candidate(ProviderKind.OAuth), now)).toBeUndefined();
    expect(open.warmed).toEqual([]);
  });

  test('quota never holds a provider that is not a subscription', () => {
    const plain = source(0, ready([exhausted(now + 60_000)]));
    expect(candidateHold(plain.source, candidate('api'), now)).toBeUndefined();
    expect(plain.warmed).toEqual([]);
  });
});
