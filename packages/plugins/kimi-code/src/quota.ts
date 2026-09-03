import type { AccountContext, OAuthQuotaItem, OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { kimiIdentityHeaders } from './headers';
import { currentKimiCredential, type KimiCredential, type KimiOAuthDependencies } from './oauth';

const numberValue = (value: unknown): number | undefined => {
  let parsed = Number.NaN;
  if (typeof value === 'number') parsed = value;
  else if (typeof value === 'string' && value.trim() !== '') parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const resetTime = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value > 1_000_000_000_000 ? value : value * 1_000);
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

function item(value: unknown, id: string, displayName: OAuthQuotaItem['displayName']): OAuthQuotaItem | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const limit = numberValue(Reflect.get(value, 'limit'));
  if (limit === undefined || limit <= 0) return undefined;
  const remaining = numberValue(Reflect.get(value, 'remaining'));
  const used = numberValue(Reflect.get(value, 'used'));
  const ratio = remaining === undefined ? (used === undefined ? undefined : 1 - used / limit) : remaining / limit;
  const rawReset = ['resetTime', 'resetAt', 'reset_time', 'reset_at']
    .map((key) => Reflect.get(value, key))
    .find((candidate) => candidate !== undefined);
  const resetsAt = resetTime(rawReset);
  return {
    id,
    displayName,
    ...(ratio === undefined ? {} : { remainingRatio: Math.min(1, Math.max(0, ratio)) }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

// Kimi ships tempo-marking tier names in its own UI; the API only returns the enum.
const PLAN_BY_LEVEL: Record<string, string> = {
  LEVEL_BASIC: 'Moderato',
  LEVEL_INTERMEDIATE: 'Allegretto',
  LEVEL_ADVANCED: 'Allegro',
  LEVEL_STANDARD: 'Vivace',
};

function membershipPlan(root: object): string | undefined {
  const user = Reflect.get(root, 'user');
  if (!isPlainObject(user)) return undefined;
  const membership = Reflect.get(user, 'membership');
  if (!isPlainObject(membership)) return undefined;
  const level = Reflect.get(membership, 'level');
  if (typeof level !== 'string') return undefined;
  // `LocalizedTextSchema` rejects untrimmed strings, so an untrimmed level that misses the lookup
  // would fail validation of the whole otherwise-valid snapshot.
  const trimmed = level.trim();
  if (trimmed === '') return undefined;
  return PLAN_BY_LEVEL[trimmed] ?? trimmed.replace('LEVEL_', '').toLowerCase();
}

export async function readKimiQuota(
  context: AccountContext<KimiCredential, Record<string, never>>,
  dependencies: KimiOAuthDependencies = {},
): Promise<OAuthQuotaSnapshot> {
  const credential = await currentKimiCredential(context.credentials, { ...dependencies, signal: context.signal });
  const response = await (dependencies.fetch ?? globalThis.fetch)('https://api.kimi.com/coding/v1/usages', {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${credential.accessToken}`,
      ...kimiIdentityHeaders(credential.deviceId),
    },
    signal: context.signal,
  });
  if (!response.ok) throw new Error(`Kimi quota request failed with ${response.status}`);
  const root: unknown = await response.json();
  if (typeof root !== 'object' || root === null) throw new Error('Kimi quota response is invalid');

  const weekly = item(Reflect.get(root, 'usage'), 'weekly', {
    default: 'Weekly quota',
    'zh-Hans': '周配额',
  });
  const rawLimits = Reflect.get(root, 'limits');
  const limits = Array.isArray(rawLimits) ? rawLimits : [];
  const windows = limits.flatMap((entry, index): OAuthQuotaItem[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const window = Reflect.get(entry, 'window');
    const duration =
      typeof window === 'object' && window !== null ? numberValue(Reflect.get(window, 'duration')) : undefined;
    const unit =
      typeof window === 'object' && window !== null && typeof Reflect.get(window, 'timeUnit') === 'string'
        ? String(Reflect.get(window, 'timeUnit'))
        : 'window';
    const normalizedUnit = unit.toLowerCase().replaceAll('_', '-');
    let shortUnit: 'minute' | 'hour' | 'day' | 'window' = 'window';
    if (unit.includes('MINUTE')) shortUnit = 'minute';
    else if (unit.includes('HOUR')) shortUnit = 'hour';
    else if (unit.includes('DAY')) shortUnit = 'day';
    const displayDuration = duration ?? index + 1;
    const chineseUnit = { day: '天', hour: '小时', minute: '分钟', window: '窗口' }[shortUnit];
    const mapped = item(Reflect.get(entry, 'detail'), `${duration ?? index}-${normalizedUnit}`, {
      default: `${displayDuration} ${shortUnit} quota`,
      'zh-Hans': `${displayDuration} ${chineseUnit}配额`,
    });
    return mapped === undefined ? [] : [mapped];
  });
  const items = [...(weekly === undefined ? [] : [weekly]), ...windows];
  if (items.length === 0) throw new Error('Kimi quota response contains no valid windows');
  const plan = membershipPlan(root);
  return { items, ...(plan === undefined ? {} : { plan }) };
}
