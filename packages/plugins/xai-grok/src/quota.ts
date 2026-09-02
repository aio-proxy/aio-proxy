import type { AccountContext, OAuthQuotaItem, OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { createXAIGrokCLIHeaders, XAI_GROK_CLI_BASE_URL } from './cli-headers/index';
import { currentXAIGrokCredential, type XAIGrokOAuthOptions } from './oauth';
import type { XAIGrokCredential } from './schema';

const WEEKLY_BILLING_URL = `${XAI_GROK_CLI_BASE_URL}/billing?format=credits`;
const MONTHLY_BILLING_URL = `${XAI_GROK_CLI_BASE_URL}/billing`;
const SETTINGS_URL = `${XAI_GROK_CLI_BASE_URL}/settings`;
const SETTINGS_TIMEOUT_MS = 2_000;
type BillingObject = {
  readonly billing_period_end?: unknown;
  readonly billingPeriodEnd?: unknown;
  readonly config?: unknown;
  readonly credit_usage_percent?: unknown;
  readonly creditUsagePercent?: unknown;
  readonly current_period?: unknown;
  readonly currentPeriod?: unknown;
  readonly end?: unknown;
  readonly monthly_limit?: unknown;
  readonly monthlyLimit?: unknown;
  readonly product_usage?: unknown;
  readonly productUsage?: unknown;
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
  const [weekly, monthly, planResult] = await Promise.allSettled([
    requestBilling(fetcher, WEEKLY_BILLING_URL, headers, context.signal, weeklyItems),
    requestBilling(fetcher, MONTHLY_BILLING_URL, headers, context.signal, monthlyItems),
    readPlan(fetcher, headers, context.signal),
  ]);
  context.signal.throwIfAborted();
  const items = dedupeItemIds([
    ...(weekly.status === 'fulfilled' ? weekly.value : []),
    ...(monthly.status === 'fulfilled' ? monthly.value : []),
  ]);
  if (items.length === 0) throw new Error('xAI Grok billing request failed');
  const plan = planResult.status === 'fulfilled' ? planResult.value : undefined;
  return { items, ...(plan === undefined ? {} : { plan }) };
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
  return typeof tier === 'string' && tier.trim() !== '' ? tier : undefined;
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
  const remainingRatio = remainingFromPercent(config.creditUsagePercent ?? config.credit_usage_percent);
  const resetsAt = timestamp(period?.end);
  // A unified-billing account reports a period but no credit percentage. Emitting the window with no
  // ratio is what makes the dashboard show 暂不适用 instead of hiding the weekly limit entirely.
  const weekly: readonly OAuthQuotaItem[] =
    remainingRatio === undefined && resetsAt === undefined
      ? []
      : [
          {
            id: 'weekly',
            displayName: { default: 'Weekly limit', 'zh-Hans': '周额度' },
            ...(remainingRatio === undefined ? {} : { remainingRatio }),
            ...(resetsAt === undefined ? {} : { resetsAt }),
          },
        ];
  return [...weekly, ...productItems(config)];
}

function monthlyItems(config: BillingObject): readonly OAuthQuotaItem[] {
  const limit = cents(config.monthlyLimit ?? config.monthly_limit);
  const used = cents(config.used);
  const remainingRatio =
    limit === undefined || limit <= 0 || used === undefined
      ? undefined
      : 1 - Math.min(Math.max(used, 0), limit) / limit;
  const resetsAt = timestamp(config.billingPeriodEnd ?? config.billing_period_end);
  if (remainingRatio === undefined && resetsAt === undefined) return [];
  return [
    {
      id: 'monthly-credits',
      displayName: { default: 'Monthly credits', 'zh-Hans': '月度额度' },
      ...(remainingRatio === undefined ? {} : { remainingRatio }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
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
    return [
      {
        id: `product_${slug}`,
        displayName: productTitle(slug),
        ...(percent === undefined ? {} : { remainingRatio: 1 - Math.min(Math.max(percent, 0), 100) / 100 }),
      },
    ];
  });
}

// The core validator rejects duplicate item ids outright, so two spellings of one product must not
// both survive as `product_grok_build`. A generated suffix can itself collide with a product that
// spells that suffix out (`grok build`, `grok build`, `grok build 2`), so every id the pass hands
// out — generated or original — is reserved and the counter walks past anything already taken.
function dedupeItemIds(items: readonly OAuthQuotaItem[]): readonly OAuthQuotaItem[] {
  const taken = new Set<string>();
  return items.map((item) => {
    if (!taken.has(item.id)) {
      taken.add(item.id);
      return item;
    }
    let count = 2;
    while (taken.has(`${item.id}_${count}`)) count += 1;
    const id = `${item.id}_${count}`;
    taken.add(id);
    return { ...item, id };
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

function remainingFromPercent(value: unknown): number | undefined {
  const used = number(value);
  return used === undefined ? undefined : 1 - Math.min(Math.max(used, 0), 100) / 100;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
