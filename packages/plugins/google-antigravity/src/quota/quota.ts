import type {
  AccountContext,
  LocalizedText,
  OAuthQuotaItem,
  OAuthQuotaSnapshot,
  RuntimeFetch,
} from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { ANTIGRAVITY_CLI_USER_AGENT } from '../oauth/constants';
import { currentGoogleCredential } from '../oauth/refresh';
import { antigravityEndpoints } from '../runtime/endpoints';
import type { GoogleAntigravityAccountOptions, GoogleAntigravityCredential } from '../schema';

const QUOTA_PATH = '/v1internal:retrieveUserQuotaSummary';
const QUOTA_ENDPOINT_TIMEOUT_MS = 10_000;

const PLAN_PATH = '/v1internal:loadCodeAssist';
const PLAN_BODY = JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } });
// The tier read is enrichment, so a slow endpoint must not hold up the quota read.
const PLAN_TIMEOUT_MS = 4_000;

// A Map, not an object literal: the tier id is unvalidated upstream text, and an object lookup
// would resolve `__proto__` or `toString` to an inherited value that blanks the whole snapshot.
const PLAN_BY_TIER_ID: ReadonlyMap<string, LocalizedText> = new Map([
  ['free-tier', { default: 'Free', 'zh-Hans': '免费版' }],
  ['g1-pro-tier', { default: 'Pro', 'zh-Hans': '专业版' }],
  ['g1-ultra-tier', { default: 'Ultra', 'zh-Hans': '旗舰版' }],
  ['g1-ultra-lite-tier', { default: 'Ultra Lite', 'zh-Hans': '轻量旗舰版' }],
]);

const FIVE_HOUR_WINDOWS = new Set(['5h', 'five-hour', 'five_hour']);
const WEEKLY_WINDOWS = new Set(['weekly', 'week']);

const FIVE_HOUR_LABEL: LocalizedText = { default: '5-hour limit', 'zh-Hans': '5 小时额度' };
const WEEKLY_LABEL: LocalizedText = { default: 'Weekly limit', 'zh-Hans': '周额度' };

export async function readGoogleAntigravityQuota(
  context: AccountContext<GoogleAntigravityCredential, GoogleAntigravityAccountOptions>,
  fetcher: RuntimeFetch = context.fetch ?? globalThis.fetch,
): Promise<OAuthQuotaSnapshot> {
  const credential = await currentGoogleCredential(context.credentials, {
    fetch: fetcher,
    signal: context.signal,
  });
  const headers = {
    Authorization: `Bearer ${credential.value.accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': ANTIGRAVITY_CLI_USER_AGENT,
  };
  const body = JSON.stringify({ project: credential.value.projectId });
  const endpoints = antigravityEndpoints(context.options, 'quota');

  // Started before the loop so it overlaps the quota request; it resolves rather than rejects, so
  // an early throw from the loop cannot leave an unhandled rejection behind.
  const planRead = readPlan(fetcher, `${endpoints[0] ?? ''}${PLAN_PATH}`, headers, context.signal);

  let lastError: Error | undefined;
  // `finally` settles the plan read on every exit, including an abort or a terminal parse throw.
  try {
    for (const endpoint of endpoints) {
      context.signal.throwIfAborted();
      let payload: unknown;
      try {
        payload = await fetchSummary(fetcher, `${endpoint}${QUOTA_PATH}`, headers, body, context.signal);
      } catch (error) {
        context.signal.throwIfAborted();
        lastError = error instanceof Error ? error : new Error('Antigravity quota request failed');
        continue;
      }
      // A base that answered speaks for the account, so a bad payload is terminal: the remaining
      // bases would only repeat it, and retrying would mask the real reason behind a stale 404.
      const items = summaryItems(payload);
      const plan = await planRead;
      return { items, ...(plan === undefined ? {} : { plan }) };
    }
  } finally {
    await planRead;
  }
  throw lastError ?? new Error('Antigravity quota request failed');
}

/** Best-effort: the tier only decorates the card, so every failure degrades to no label. */
async function readPlan(
  fetcher: RuntimeFetch,
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<LocalizedText | undefined> {
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers,
      body: PLAN_BODY,
      signal: AbortSignal.any([signal, AbortSignal.timeout(PLAN_TIMEOUT_MS)]),
      aioProxy: { traffic: 'control' },
    });
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    if (!isPlainObject(payload)) return undefined;
    const paid = tier(Reflect.get(payload, 'paidTier') ?? Reflect.get(payload, 'paid_tier'));
    const current = tier(Reflect.get(payload, 'currentTier') ?? Reflect.get(payload, 'current_tier'));
    // A paid tier only counts once it names an id; an empty paid slot means the free plan applies.
    const effective = paid?.id === undefined ? current : paid;
    if (effective === undefined) return undefined;
    // Google's own `name` is what the user sees in Antigravity, and it stays right for tier ids we
    // have not mapped, so it wins over the built-in label.
    return (
      effective.name ?? (effective.id === undefined ? undefined : (PLAN_BY_TIER_ID.get(effective.id) ?? effective.id))
    );
  } catch {
    return undefined;
  }
}

function tier(value: unknown): { readonly id?: string; readonly name?: string } | undefined {
  if (!isPlainObject(value)) return undefined;
  const id = nonEmpty(Reflect.get(value, 'id'));
  const name = nonEmpty(Reflect.get(value, 'name'));
  if (id === undefined && name === undefined) return undefined;
  return { ...(id === undefined ? {} : { id }), ...(name === undefined ? {} : { name }) };
}

async function fetchSummary(
  fetcher: RuntimeFetch,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetcher(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(QUOTA_ENDPOINT_TIMEOUT_MS)]),
    aioProxy: { traffic: 'control' },
  });
  if (!response.ok) throw new Error(`Antigravity quota request failed with ${response.status}`);
  return await response.json();
}

function summaryItems(payload: unknown): readonly OAuthQuotaItem[] {
  if (!isPlainObject(payload)) throw new Error('Antigravity quota response is invalid');
  const items = dedupeItemIds(groupItems(Reflect.get(payload, 'groups')));
  if (items.length === 0) throw new Error('Antigravity quota response contains no usable buckets');
  return items;
}

/** `groups[]` in payload order; one malformed group must not discard its siblings. */
function groupItems(value: unknown): readonly OAuthQuotaItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((group, groupIndex): OAuthQuotaItem[] => {
    if (!isPlainObject(group)) return [];
    const label = nonEmpty(Reflect.get(group, 'displayName') ?? Reflect.get(group, 'display_name'));
    const slug = slugify(label ?? '') || `group-${groupIndex + 1}`;
    const buckets = Reflect.get(group, 'buckets');
    if (!Array.isArray(buckets)) return [];
    return buckets
      .flatMap((bucket, bucketIndex): OAuthQuotaItem[] => {
        const item = bucketItem(bucket, slug, label, bucketIndex);
        return item === undefined ? [] : [item];
      })
      .sort((left, right) => windowOrder(left.id, slug) - windowOrder(right.id, slug));
  });
}

function bucketItem(
  value: unknown,
  groupSlug: string,
  groupLabel: string | undefined,
  index: number,
): OAuthQuotaItem | undefined {
  if (!isPlainObject(value)) return undefined;
  // A row with no fraction renders as an empty ring, which reads as "nothing left". Drop it.
  const fraction = quotaFraction(Reflect.get(value, 'remainingFraction') ?? Reflect.get(value, 'remaining_fraction'));
  if (fraction === undefined) return undefined;
  const window = nonEmpty(Reflect.get(value, 'window'))?.toLowerCase();
  const bucketSlug =
    windowSlug(window) ?? slugify(nonEmpty(Reflect.get(value, 'bucketId') ?? Reflect.get(value, 'bucket_id')) ?? '');
  const id = `${groupSlug}-${bucketSlug === '' ? `bucket-${index + 1}` : bucketSlug}`;
  const upstreamLabel = nonEmpty(Reflect.get(value, 'displayName') ?? Reflect.get(value, 'display_name'));
  // An unrecognized window with no upstream label has no name to render at all; drop it.
  const label = windowLabel(window, upstreamLabel);
  if (label === undefined) return undefined;
  const resetsAt = timestamp(Reflect.get(value, 'resetTime') ?? Reflect.get(value, 'reset_time'));
  return {
    id,
    displayName: groupLabel === undefined ? label : prefixed(groupLabel, label),
    remainingRatio: Math.min(1, Math.max(0, fraction)),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/** The two known windows get a translated label; anything else keeps the upstream string. */
function windowLabel(window: string | undefined, upstreamLabel: string | undefined): LocalizedText | undefined {
  const slug = windowSlug(window);
  if (slug === '5h') return FIVE_HOUR_LABEL;
  if (slug === 'weekly') return WEEKLY_LABEL;
  return upstreamLabel === undefined ? undefined : { default: upstreamLabel };
}

/** Canonical slug for the two windows Antigravity actually reports, in either spelling. */
function windowSlug(window: string | undefined): '5h' | 'weekly' | undefined {
  if (window === undefined) return undefined;
  if (FIVE_HOUR_WINDOWS.has(window)) return '5h';
  return WEEKLY_WINDOWS.has(window) ? 'weekly' : undefined;
}

/** Five-hour first, weekly next, unrecognized windows last in payload order (sort is stable). */
function windowOrder(id: string, groupSlug: string): number {
  if (id === `${groupSlug}-5h`) return 0;
  if (id === `${groupSlug}-weekly`) return 1;
  return 2;
}

function prefixed(prefix: string, label: LocalizedText): LocalizedText {
  const values = typeof label === 'string' ? { default: label } : label;
  return Object.fromEntries(
    Object.entries(values).map(([locale, text]) => [locale, `${prefix} · ${text}`]),
  ) as LocalizedText;
}

// The core validator rejects duplicate item ids outright, which would blank the whole card. Two
// buckets naming the same window in one group must both survive, so a suffix beats a throw.
function dedupeItemIds(items: readonly OAuthQuotaItem[]): readonly OAuthQuotaItem[] {
  const taken = new Set<string>();
  return items.map((item) => {
    if (!taken.has(item.id)) {
      taken.add(item.id);
      return item;
    }
    let count = 2;
    while (taken.has(`${item.id}-${count}`)) count += 1;
    const id = `${item.id}-${count}`;
    taken.add(id);
    return { ...item, id };
  });
}

/** `remaining_fraction` is 0..1, but some payloads spell it as a `"55%"` string. */
function quotaFraction(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const text = nonEmpty(value);
  if (text === undefined) return undefined;
  const parsed = Number(text.endsWith('%') ? text.slice(0, -1) : text);
  if (!Number.isFinite(parsed)) return undefined;
  return text.endsWith('%') ? parsed / 100 : parsed;
}

/** `resetTime` is ISO-8601; tolerate over-precise fractional seconds some payloads emit. */
function timestamp(value: unknown): number | undefined {
  const text = nonEmpty(value);
  if (text === undefined) return undefined;
  const parsed = Date.parse(text.replace(/(\.\d{6})\d+/u, '$1'));
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '');
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
