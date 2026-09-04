import type { LocalizedText, OAuthQuotaItem, RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { clamp } from 'es-toolkit/math';
import { isPlainObject } from 'es-toolkit/predicate';

export const CURSOR_USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary';

const PLAN_LABEL: LocalizedText = { default: 'Plan usage', 'zh-Hans': '套餐用量' };
const AUTO_LABEL: LocalizedText = { default: 'Auto models', 'zh-Hans': 'Auto 模型' };
const API_LABEL: LocalizedText = { default: 'Named models', 'zh-Hans': '指定模型' };
const ON_DEMAND_LABEL: LocalizedText = { default: 'On-demand budget', 'zh-Hans': '按量预算' };

// Cursor's own dashboard copy for each `membershipType` enum value.
const MEMBERSHIP_NAMES: Readonly<Record<string, string>> = {
  enterprise: 'Enterprise',
  express: 'Start',
  free: 'Free',
  free_trial: 'Pro Trial',
  hobby: 'Hobby',
  pro: 'Pro',
  pro_plus: 'Pro+',
  pro_student: 'Pro',
  team: 'Team',
  ultra: 'Ultra',
};

export type CursorSummaryQuota = {
  readonly items: readonly OAuthQuotaItem[];
  readonly plan?: string;
};

export async function readUsageSummary(
  fetcher: RuntimeFetch,
  cookie: string,
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  const response = await fetcher(CURSOR_USAGE_SUMMARY_URL, {
    headers: { Accept: 'application/json', Cookie: cookie },
    signal,
    aioProxy: { traffic: 'control' },
  });
  // The wrong-subject and expired-session cases land here and need a legible instruction.
  if (response.status === 401 || response.status === 403) {
    throw new Error('Cursor rejected the session cookie; sign in to Cursor again');
  }
  if (!response.ok) throw new Error(`Cursor usage summary request failed with ${response.status}`);
  const payload: unknown = await response.json();
  if (!isPlainObject(payload)) throw new Error('Cursor usage summary response is invalid');
  return payload;
}

export function summaryQuota(payload: Readonly<Record<string, unknown>>): CursorSummaryQuota {
  const individual = record(Reflect.get(payload, 'individualUsage'));
  const plan = record(individual === undefined ? undefined : Reflect.get(individual, 'plan'));
  const resetsAt = isoTimestamp(Reflect.get(payload, 'billingCycleEnd'));

  const auto = plan === undefined ? undefined : remainingFromPercent(Reflect.get(plan, 'autoPercentUsed'));
  const api = plan === undefined ? undefined : remainingFromPercent(Reflect.get(plan, 'apiPercentUsed'));
  const onDemand = ratioFromCents(individual === undefined ? undefined : Reflect.get(individual, 'onDemand'));

  const items = [
    item('plan', PLAN_LABEL, planRatio(payload, plan, auto, api), resetsAt),
    item('auto', AUTO_LABEL, auto, resetsAt),
    item('api', API_LABEL, api, resetsAt),
    item('on-demand', ON_DEMAND_LABEL, onDemand, resetsAt),
  ].filter((entry): entry is OAuthQuotaItem => entry !== undefined);

  const membership = membershipPlan(Reflect.get(payload, 'membershipType'));
  return { items, ...(membership === undefined ? {} : { plan: membership }) };
}

/**
 * Cursor reports the headline number in six different places depending on plan shape.
 * Enterprise and Team accounts have no `plan` block at all, so the last two rungs are load-bearing.
 */
function planRatio(
  payload: Readonly<Record<string, unknown>>,
  plan: Readonly<Record<string, unknown>> | undefined,
  auto: number | undefined,
  api: number | undefined,
): number | undefined {
  if (plan !== undefined) {
    const total = remainingFromPercent(Reflect.get(plan, 'totalPercentUsed'));
    if (total !== undefined) return total;
    if (auto !== undefined && api !== undefined) return (auto + api) / 2;
    if (api !== undefined) return api;
    if (auto !== undefined) return auto;
    const planCents = ratioFromCents(plan);
    if (planCents !== undefined) return planCents;
  }
  const individual = record(Reflect.get(payload, 'individualUsage'));
  const overall = ratioFromCents(individual === undefined ? undefined : Reflect.get(individual, 'overall'));
  if (overall !== undefined) return overall;
  const team = record(Reflect.get(payload, 'teamUsage'));
  return ratioFromCents(team === undefined ? undefined : Reflect.get(team, 'pooled'));
}

/** Percent fields are percentage units even when fractional: `0.36` means 0.36%. */
export function remainingFromPercent(value: unknown): number | undefined {
  const percent = finite(value);
  return percent === undefined ? undefined : 1 - clamp(percent, 0, 100) / 100;
}

export function isoTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** `used` / `limit` blocks are denominated in cents; only the ratio survives into the snapshot. */
function ratioFromCents(value: unknown): number | undefined {
  const block = record(value);
  if (block === undefined) return undefined;
  const limit = finite(Reflect.get(block, 'limit'));
  const used = finite(Reflect.get(block, 'used'));
  if (limit === undefined || limit <= 0 || used === undefined) return undefined;
  return 1 - clamp(used / limit, 0, 1);
}

// An item with no ratio renders an empty bar, which reads as "nothing left". Omit it instead.
function item(
  id: string,
  displayName: LocalizedText,
  remainingRatio: number | undefined,
  resetsAt: number | undefined,
): OAuthQuotaItem | undefined {
  if (remainingRatio === undefined) return undefined;
  return { id, displayName, remainingRatio, ...(resetsAt === undefined ? {} : { resetsAt }) };
}

// `LocalizedTextSchema` rejects untrimmed strings, so an untrimmed enum would fail the whole snapshot.
function membershipPlan(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  // The key is upstream JSON, so `constructor` must fall through instead of rendering Object.prototype.
  const key = trimmed.toLowerCase();
  return `Cursor ${Object.hasOwn(MEMBERSHIP_NAMES, key) ? MEMBERSHIP_NAMES[key] : trimmed}`;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isPlainObject(value) ? value : undefined;
}
