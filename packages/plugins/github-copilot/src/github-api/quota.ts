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
  // One `claimed` set spans both readers, and the snapshots run first so the counters only speak for
  // windows the snapshots left unanswered.
  const claimed = new Set<string>();
  const snapshots = snapshotItems(payload, resetsAt, claimed);
  const items = [...snapshots, ...counterItems(payload, resetsAt, claimed)];
  const plan = planText(Reflect.get(payload, 'copilot_plan'));
  // An all-unlimited or token-billed seat legitimately meters nothing. That is an empty snapshot, not
  // a failure: throwing would paint the "load failed" ring over a read that worked.
  return { items, ...(plan === undefined ? {} : { plan }) };
}

/**
 * The one place an id is allowed to enter a snapshot. `validateOAuthQuotaSnapshot` discards the
 * entire snapshot over a single duplicate id, so every emitter has to claim through here: two payload
 * keys can trim into the same id within one object (`chat` and `' chat'`) as easily as across the two
 * readers. First claim wins; a key that trims to nothing was never an id.
 */
function claim(claimed: Set<string>, key: string): string | undefined {
  const id = key.trim();
  if (id === '' || claimed.has(id)) return undefined;
  claimed.add(id);
  return id;
}

/**
 * A window the snapshots answered for is claimed even when it is deliberately left out of `items`:
 * an unmetered seat must not reappear at some counter-derived percentage. An entry the snapshots
 * could not parse at all is not claimed, so the legacy counters may still speak for it.
 */
function snapshotItems(
  payload: Readonly<Record<string, unknown>>,
  resetsAt: number | undefined,
  claimed: Set<string>,
): readonly OAuthQuotaItem[] {
  const snapshots = Reflect.get(payload, 'quota_snapshots');
  if (!isPlainObject(snapshots)) return [];
  const items: OAuthQuotaItem[] = [];
  for (const key of Object.keys(snapshots)) {
    const value = Reflect.get(snapshots, key);
    if (!isPlainObject(value)) continue;
    // An unmetered window is an answer — claim it so the counters cannot resurrect it — but an
    // unreadable ratio is "no answer", and claiming it would silence the counter fallback.
    if (unmetered(value)) {
      claim(claimed, key);
      continue;
    }
    const ratio = snapshotRatio(value);
    if (ratio === undefined) continue;
    const id = claim(claimed, key);
    if (id !== undefined) items.push(quotaItem(id, ratio, resetsAt));
  }
  return items;
}

/**
 * A window with no denominator to measure against: an unlimited allowance, or the zero entitlement
 * GitHub serves for token-based billing and Business seats — sometimes alongside
 * `percent_remaining: 100`, which would otherwise render as a full allowance. `remaining` is optional
 * upstream, so an entitlement of `0` has to stand on its own, and `unlimited` is trusted as a claim
 * rather than as a boolean: any non-nullish value other than `false` still says unlimited. `null` is
 * upstream's "no answer", not a claim, and must not suppress a genuinely metered window.
 */
function unmetered(snapshot: Readonly<Record<string, unknown>>): boolean {
  const unlimited = Reflect.get(snapshot, 'unlimited');
  if (unlimited != null && unlimited !== false) return true;
  return number(Reflect.get(snapshot, 'entitlement')) === 0;
}

/** Callers screen for `unmetered` first; this only runs on a window with a real denominator. */
function snapshotRatio(snapshot: Readonly<Record<string, unknown>>): number | undefined {
  const percent = number(Reflect.get(snapshot, 'percent_remaining'));
  if (percent !== undefined) return clampRatio(percent / 100);
  const entitlement = number(Reflect.get(snapshot, 'entitlement'));
  const remaining = number(Reflect.get(snapshot, 'remaining'));
  if (entitlement === undefined || entitlement <= 0 || remaining === undefined) return undefined;
  return clampRatio(remaining / entitlement);
}

/**
 * Free and older seats answer with counters instead of snapshots: `monthly_quotas` is the allowance
 * and `limited_user_quotas` is what is left. Ids already claimed are skipped, whether the claim came
 * from `quota_snapshots` or from an earlier counter key that trimmed to the same id.
 */
function counterItems(
  payload: Readonly<Record<string, unknown>>,
  resetsAt: number | undefined,
  claimed: Set<string>,
): readonly OAuthQuotaItem[] {
  const monthly = Reflect.get(payload, 'monthly_quotas');
  const limited = Reflect.get(payload, 'limited_user_quotas');
  if (!isPlainObject(monthly) || !isPlainObject(limited)) return [];
  const items: OAuthQuotaItem[] = [];
  for (const key of Object.keys(monthly)) {
    const entitlement = number(Reflect.get(monthly, key));
    const remaining = number(Reflect.get(limited, key));
    if (entitlement === undefined || entitlement <= 0 || remaining === undefined) continue;
    const id = claim(claimed, key);
    if (id === undefined) continue;
    items.push(quotaItem(id, clampRatio(remaining / entitlement), resetsAt));
  }
  return items;
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
