import { describe, expect, test } from 'bun:test';

import type { OAuthQuotaItem } from '@aio-proxy/plugin-sdk';

import type { OAuthQuotaCacheStatus } from '../../../plugin-quota';
import { QUOTA_SNAPSHOT_MAX_AGE_MS, quotaHeldUntil, quotaScopeCovers } from './quota-gate';

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
