import type {
  AccountContext,
  LocalizedText,
  OAuthQuotaItem,
  OAuthQuotaSnapshot,
  RuntimeFetch,
} from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { copilotUserResponseSchema } from '../schema';
import { fetchJson, githubUserHeaders } from './http';
import type { GitHubAccountOptions, GitHubCopilotCredential } from './types';
import { githubApiBase } from './urls';

// A `Map`, not an object literal: a payload key of `constructor` or `__proto__` must not pull a
// function off `Object.prototype` and hand it to the snapshot validator as a display name.
const QUOTA_LABELS = new Map<string, LocalizedText>([
  ['premium_interactions', { default: 'Premium requests', 'zh-Hans': '高级请求' }],
  ['chat', { default: 'Chat', 'zh-Hans': '聊天' }],
  ['completions', { default: 'Code completions', 'zh-Hans': '代码补全' }],
]);

export async function readGitHubCopilotQuota(
  context: AccountContext<GitHubCopilotCredential, GitHubAccountOptions>,
  fetcher: RuntimeFetch = context.fetch ?? globalThis.fetch,
): Promise<OAuthQuotaSnapshot> {
  // Read the credential directly rather than through `currentGitHubCopilotCredential`: this endpoint
  // authenticates the long-lived GitHub token, so refreshing the Copilot token would be a wasted
  // round trip on every poll.
  const { value: credential } = await context.credentials.read();
  const payload = await fetchJson(
    `${githubApiBase(credential.enterpriseURL)}/copilot_internal/user`,
    {
      headers: githubUserHeaders(credential.githubToken),
      signal: context.signal,
      aioProxy: { traffic: 'control' },
    },
    copilotUserResponseSchema,
    fetcher,
  );
  context.signal.throwIfAborted();

  // GitHub reports one account-wide monthly boundary, not a per-window reset, so every item shares it.
  const resetsAt = timestamp(Reflect.get(payload, 'quota_reset_date'));
  const { items: snapshots, covered } = snapshotItems(payload, resetsAt);
  const items = [...snapshots, ...counterItems(payload, resetsAt, covered)];
  const plan = planText(Reflect.get(payload, 'copilot_plan'));
  // An all-unlimited or token-billed seat legitimately meters nothing. That is an empty snapshot, not
  // a failure: throwing would paint the "load failed" ring over a read that worked.
  return { items, ...(plan === undefined ? {} : { plan }) };
}

/**
 * `covered` is every id `quota_snapshots` had an answer for, which includes the unmetered windows
 * deliberately left out of `items`. An entry the snapshots could not parse at all is not covered, so
 * the legacy counters may still speak for it.
 */
function snapshotItems(
  payload: Readonly<Record<string, unknown>>,
  resetsAt: number | undefined,
): { readonly items: readonly OAuthQuotaItem[]; readonly covered: ReadonlySet<string> } {
  const snapshots = Reflect.get(payload, 'quota_snapshots');
  const items: OAuthQuotaItem[] = [];
  const covered = new Set<string>();
  if (!isPlainObject(snapshots)) return { items, covered };
  for (const key of Object.keys(snapshots)) {
    const id = key.trim();
    const value = Reflect.get(snapshots, key);
    if (id === '' || !isPlainObject(value)) continue;
    if (unmetered(value)) {
      covered.add(id);
      continue;
    }
    const ratio = snapshotRatio(value);
    if (ratio === undefined) continue;
    covered.add(id);
    items.push(quotaItem(id, ratio, resetsAt));
  }
  return { items, covered };
}

/**
 * A window with no denominator to measure against: an unlimited allowance, or the explicit zero/zero
 * GitHub serves for token-based billing and Business seats — sometimes alongside
 * `percent_remaining: 100`, which would otherwise render as a full allowance.
 */
function unmetered(snapshot: Readonly<Record<string, unknown>>): boolean {
  if (Reflect.get(snapshot, 'unlimited') === true) return true;
  return number(Reflect.get(snapshot, 'entitlement')) === 0 && number(Reflect.get(snapshot, 'remaining')) === 0;
}

function snapshotRatio(snapshot: Readonly<Record<string, unknown>>): number | undefined {
  if (unmetered(snapshot)) return undefined;
  const percent = number(Reflect.get(snapshot, 'percent_remaining'));
  if (percent !== undefined) return clampRatio(percent / 100);
  const entitlement = number(Reflect.get(snapshot, 'entitlement'));
  const remaining = number(Reflect.get(snapshot, 'remaining'));
  if (entitlement === undefined || entitlement <= 0 || remaining === undefined) return undefined;
  return clampRatio(remaining / entitlement);
}

/**
 * Free and older seats answer with counters instead of snapshots: `monthly_quotas` is the allowance
 * and `limited_user_quotas` is what is left. Windows `quota_snapshots` already covered are skipped —
 * a duplicate id makes the core validator reject the whole snapshot, valid windows included, and an
 * unmetered window must not be resurrected here at some counter-derived percentage.
 */
function counterItems(
  payload: Readonly<Record<string, unknown>>,
  resetsAt: number | undefined,
  covered: ReadonlySet<string>,
): readonly OAuthQuotaItem[] {
  const monthly = Reflect.get(payload, 'monthly_quotas');
  const limited = Reflect.get(payload, 'limited_user_quotas');
  if (!isPlainObject(monthly) || !isPlainObject(limited)) return [];
  return Object.keys(monthly).flatMap((key): OAuthQuotaItem[] => {
    const id = key.trim();
    if (id === '' || covered.has(id)) return [];
    const entitlement = number(Reflect.get(monthly, key));
    const remaining = number(Reflect.get(limited, key));
    if (entitlement === undefined || entitlement <= 0 || remaining === undefined) return [];
    return [quotaItem(id, clampRatio(remaining / entitlement), resetsAt)];
  });
}

function quotaItem(id: string, remainingRatio: number, resetsAt: number | undefined): OAuthQuotaItem {
  return {
    id,
    displayName: QUOTA_LABELS.get(id) ?? titleCase(id) ?? id,
    remainingRatio,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/** `copilot_plan` is an upstream enum (`copilot_business`, `free`); `unknown` is its "no answer". */
function planText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const plan = value.trim();
  if (plan === '' || plan.toLowerCase() === 'unknown') return undefined;
  return titleCase(plan);
}

// `LocalizedTextSchema` rejects empty and untrimmed strings, and a rejected label or plan fails the
// whole otherwise-valid snapshot, so a title-case that collapses to nothing returns undefined.
function titleCase(value: string): string | undefined {
  const text = value
    .split(/[\s_-]+/u)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return text === '' ? undefined : text;
}

function number(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampRatio(ratio: number): number {
  return Math.min(Math.max(ratio, 0), 1);
}

/** `quota_reset_date` is ISO-8601 or a bare `yyyy-mm-dd`; both go through `Date.parse`. */
function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Date.parse(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
