import {
  dedupeQuotaItemIds,
  type AccountContext,
  type OAuthQuotaItem,
  type OAuthQuotaSnapshot,
} from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { createXAIGrokCLIHeaders, XAI_GROK_CLI_BASE_URL } from './cli-headers/index';
import { currentXAIGrokCredential, type XAIGrokOAuthOptions } from './oauth';
import { readXAIGrokResetCredits, resetXAIGrokQuota } from './quota-resets';
import type { XAIGrokCredential } from './schema';

export { resetXAIGrokQuota };

const WEEKLY_BILLING_URL = `${XAI_GROK_CLI_BASE_URL}/billing?format=credits`;
const MONTHLY_BILLING_URL = `${XAI_GROK_CLI_BASE_URL}/billing`;
const SETTINGS_URL = `${XAI_GROK_CLI_BASE_URL}/settings`;
const SETTINGS_TIMEOUT_MS = 2_000;
type BillingObject = {
  readonly billing_period_end?: unknown;
  readonly billing_period_start?: unknown;
  readonly billingPeriodEnd?: unknown;
  readonly billingPeriodStart?: unknown;
  readonly config?: unknown;
  readonly credit_usage_percent?: unknown;
  readonly creditUsagePercent?: unknown;
  readonly current_period?: unknown;
  readonly currentPeriod?: unknown;
  readonly end?: unknown;
  readonly monthly_limit?: unknown;
  readonly monthlyLimit?: unknown;
  readonly on_demand_cap?: unknown;
  readonly on_demand_used?: unknown;
  readonly onDemandCap?: unknown;
  readonly onDemandUsed?: unknown;
  readonly product_usage?: unknown;
  readonly productUsage?: unknown;
  readonly start?: unknown;
  readonly used?: unknown;
  readonly val?: unknown;
};

export async function readXAIGrokQuota(
  context: AccountContext<XAIGrokCredential, Record<string, never>>,
  options: XAIGrokOAuthOptions = {},
): Promise<OAuthQuotaSnapshot> {
  const credential = await currentXAIGrokCredential(context.credentials, { ...options, signal: context.signal });
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = createXAIGrokCLIHeaders(credential, { accept: '*/*' });
  if (credential.subject !== undefined) headers.set('x-userid', credential.subject);
  const [weekly, monthly, planResult, resetCredits] = await Promise.allSettled([
    requestBilling(fetcher, WEEKLY_BILLING_URL, headers, context.signal, weeklyItems),
    requestBilling(fetcher, MONTHLY_BILLING_URL, headers, context.signal, monthlyItems),
    readPlan(fetcher, headers, context.signal),
    readXAIGrokResetCredits(fetcher, headers, context.signal),
  ]);
  context.signal.throwIfAborted();
  const items = dedupeQuotaItemIds(
    [...(weekly.status === 'fulfilled' ? weekly.value : []), ...(monthly.status === 'fulfilled' ? monthly.value : [])],
    '_',
  );
  if (items.length === 0) throw new Error('xAI Grok billing request failed');
  const plan = planResult.status === 'fulfilled' ? planResult.value : undefined;
  const credits = resetCredits.status === 'fulfilled' ? resetCredits.value : undefined;
  return {
    items,
    ...(plan === undefined ? {} : { plan }),
    ...(credits === undefined ? {} : { resetCredits: credits }),
  };
}

async function readPlan(
  fetcher: NonNullable<XAIGrokOAuthOptions['fetch']>,
  headers: Headers,
  signal: AbortSignal,
): Promise<string | undefined> {
  // Optional enrichment: a slow or missing /settings must never fail the quota read.
  const response = await fetcher(SETTINGS_URL, {
    method: 'GET',
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(SETTINGS_TIMEOUT_MS)]),
  });
  if (!response.ok) return undefined;
  const payload = record(await response.json());
  const tier = payload === undefined ? undefined : Reflect.get(payload, 'subscription_tier_display');
  if (typeof tier !== 'string') return undefined;
  // `LocalizedTextSchema` rejects untrimmed strings, so passing the tier through verbatim would turn
  // this optional enrichment into a failure of the whole otherwise-valid snapshot.
  const trimmed = tier.trim();
  return trimmed === '' ? undefined : trimmed;
}

async function requestBilling(
  fetcher: NonNullable<XAIGrokOAuthOptions['fetch']>,
  url: string,
  headers: Headers,
  signal: AbortSignal,
  toItems: (config: BillingObject) => readonly OAuthQuotaItem[],
): Promise<readonly OAuthQuotaItem[]> {
  const response = await fetcher(url, { method: 'GET', headers, signal });
  if (!response.ok) throw new Error(`xAI Grok billing request failed (${response.status})`);
  const payload = record(await response.json());
  return payload === undefined ? [] : toItems(record(payload.config) ?? {});
}

function weeklyItems(config: BillingObject): readonly OAuthQuotaItem[] {
  const period = record(config.currentPeriod ?? config.current_period);
  const periodStart = timestamp(period?.start);
  const periodEnd = timestamp(period?.end);
  const billingStart = timestamp(config.billingPeriodStart ?? config.billing_period_start);
  const billingEnd = timestamp(config.billingPeriodEnd ?? config.billing_period_end);
  // The credits payload's current period is the live window. The billing period is only a fallback
  // when that end is missing, and its start must not be paired with a different end.
  const resetsAt = periodEnd ?? billingEnd;
  const windowMinutes =
    periodEnd === undefined ? spanMinutes(billingStart, billingEnd) : spanMinutes(periodStart, periodEnd);
  // creditUsagePercent is used-percent. An omitted figure on a real window is 0% used (proto3 drops
  // the zero), which is a full remaining amount — not an unknown window and not a dropped one.
  const remainingRatio = weeklyRemaining(config) ?? (resetsAt === undefined ? undefined : 1);
  const weekly: readonly OAuthQuotaItem[] =
    remainingRatio === undefined && resetsAt === undefined
      ? []
      : [
          {
            id: 'weekly',
            displayName: { default: 'Weekly limit', 'zh-Hans': '周额度' },
            ...(remainingRatio === undefined ? {} : { remainingRatio }),
            ...(resetsAt === undefined ? {} : { resetsAt }),
            ...(windowMinutes === undefined ? {} : { windowMinutes }),
          },
        ];
  return [...weekly, ...productItems(config)];
}

/** Window length from both ends of a billing period; a non-positive span is not a window. */
function spanMinutes(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  const minutes = Math.round((end - start) / 60_000);
  return minutes > 0 ? minutes : undefined;
}

function monthlyItems(config: BillingObject): readonly OAuthQuotaItem[] {
  const limit = cents(config.monthlyLimit ?? config.monthly_limit);
  const reportedUsed = cents(config.used);
  // `used` is consumed credits. Omitted next to a positive limit is 0 spent, the same as a used percent
  // the credits payload left out.
  const used = reportedUsed ?? (limit !== undefined && limit > 0 ? 0 : undefined);
  const remainingRatio =
    limit === undefined || limit <= 0 || used === undefined
      ? undefined
      : 1 - Math.min(Math.max(used, 0), limit) / limit;
  const resetsAt = timestamp(config.billingPeriodEnd ?? config.billing_period_end);
  const windowMinutes = spanMinutes(timestamp(config.billingPeriodStart ?? config.billing_period_start), resetsAt);
  if (remainingRatio === undefined && resetsAt === undefined) return [];
  return [
    {
      id: 'monthly-credits',
      displayName: { default: 'Monthly credits', 'zh-Hans': '月度额度' },
      ...(remainingRatio === undefined ? {} : { remainingRatio }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(windowMinutes === undefined ? {} : { windowMinutes }),
    },
  ];
}

// xAI spells the same product three ways across payloads; collapse them so the dashboard shows one row.
const PRODUCT_ALIASES: Record<string, string> = { grokbuild: 'grok_build', productgrokbuild: 'grok_build' };

function productSlug(product: string): string {
  const normalized = product
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '');
  return PRODUCT_ALIASES[normalized] ?? normalized;
}

function productTitle(slug: string): string {
  return slug
    .split('_')
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function productItems(config: BillingObject): readonly OAuthQuotaItem[] {
  const raw = config.productUsage ?? config.product_usage;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): OAuthQuotaItem[] => {
    const usage = record(entry);
    if (usage === undefined) return [];
    const product = Reflect.get(usage, 'product');
    if (typeof product !== 'string') return [];
    const slug = productSlug(product);
    if (slug === '') return [];
    const percent = number(Reflect.get(usage, 'usagePercent') ?? Reflect.get(usage, 'usage_percent'));
    // usagePercent is used-percent. A product row that omits it has used nothing.
    const remainingRatio = percent === undefined ? 1 : 1 - Math.min(Math.max(percent, 0), 100) / 100;
    return [
      {
        id: `product_${slug}`,
        displayName: productTitle(slug),
        remainingRatio,
      },
    ];
  });
}

function record(value: unknown): BillingObject | undefined {
  return isPlainObject(value) ? value : undefined;
}

function number(value: unknown): number | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : undefined;
  if (trimmed === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cents(value: unknown): number | undefined {
  return number(record(value)?.val ?? value);
}

function weeklyRemaining(config: BillingObject): number | undefined {
  return (
    remainingFromPercent(config.creditUsagePercent ?? config.credit_usage_percent) ??
    remainingFromPercent(onDemandUsedPercent(config))
  );
}

/**
 * On-demand spend as a used percent, only when the cap is a positive meter. A zero cap is "no
 * on-demand limit", which is not the same as having used none of it.
 */
function onDemandUsedPercent(config: BillingObject): number | undefined {
  const cap = cents(config.onDemandCap ?? config.on_demand_cap);
  const used = cents(config.onDemandUsed ?? config.on_demand_used);
  if (cap === undefined || cap <= 0 || used === undefined) return undefined;
  return (Math.min(Math.max(used, 0), cap) / cap) * 100;
}

function remainingFromPercent(value: unknown): number | undefined {
  const used = number(value);
  return used === undefined ? undefined : 1 - Math.min(Math.max(used, 0), 100) / 100;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
