import type {
  AccountContext,
  LocalizedText,
  OAuthQuotaItem,
  OAuthQuotaResetCredit,
  OAuthQuotaResetCredits,
  OAuthQuotaSnapshot,
  RuntimeFetch,
} from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { CHATGPT_USER_AGENT, currentCredential } from '../runtime/index';
import type { ChatGPTCredential } from '../schema';

const CHATGPT_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api' as const;
const USAGE_URL = `${CHATGPT_BACKEND_BASE_URL}/wham/usage` as const;
const RESET_CREDITS_URL = `${CHATGPT_BACKEND_BASE_URL}/wham/rate-limit-reset-credits` as const;
// The reset-credit inventory is enrichment, so a slow endpoint must not hold up the usage read.
const RESET_CREDITS_TIMEOUT_MS = 4_000;

const WEEK_SECONDS = 7 * 24 * 60 * 60;

export async function readOpenAIChatGPTQuota(
  context: AccountContext<ChatGPTCredential, Record<string, never>>,
  fetcher: RuntimeFetch = context.fetch ?? globalThis.fetch,
): Promise<OAuthQuotaSnapshot> {
  const credential = await currentCredential(context.credentials, fetcher);
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${credential.accessToken}`,
    'ChatGPT-Account-Id': credential.accountId,
    'User-Agent': CHATGPT_USER_AGENT,
  };

  const [usage, resetCredits] = await Promise.all([
    readUsage(fetcher, headers, context.signal),
    readResetCredits(fetcher, headers, context.signal),
  ]);
  context.signal.throwIfAborted();

  const items = dedupeItemIds([...laneItems(usage), ...additionalItems(usage)]);
  if (items.length === 0) throw new Error('ChatGPT usage response contains no rate limit windows');
  const plan = planText(Reflect.get(usage, 'plan_type'));
  return {
    items,
    ...(resetCredits === undefined ? {} : { resetCredits }),
    ...(plan === undefined ? {} : { plan }),
  };
}

async function readUsage(
  fetcher: RuntimeFetch,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  const response = await fetcher(USAGE_URL, { headers, signal, aioProxy: { traffic: 'control' } });
  if (!response.ok) throw new Error(`ChatGPT usage request failed with ${response.status}`);
  const payload: unknown = await response.json();
  if (!isPlainObject(payload)) throw new Error('ChatGPT usage response is invalid');
  return payload;
}

async function readResetCredits(
  fetcher: RuntimeFetch,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<OAuthQuotaResetCredits | undefined> {
  try {
    const response = await fetcher(RESET_CREDITS_URL, {
      headers: { ...headers, 'OpenAI-Beta': 'codex-1', originator: 'Codex Desktop' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(RESET_CREDITS_TIMEOUT_MS)]),
      aioProxy: { traffic: 'control' },
    });
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    if (!isPlainObject(payload)) return undefined;
    const availableCount = integer(Reflect.get(payload, 'available_count'));
    if (availableCount === undefined || availableCount < 0) return undefined;
    const rawCredits = Reflect.get(payload, 'credits');
    const seen = new Set<string>();
    const items = (Array.isArray(rawCredits) ? rawCredits : []).flatMap((entry): OAuthQuotaResetCredit[] => {
      if (!isPlainObject(entry)) return [];
      const id = Reflect.get(entry, 'id');
      if (typeof id !== 'string' || id.trim() === '' || seen.has(id)) return [];
      seen.add(id);
      const expiresAt = timestamp(Reflect.get(entry, 'expires_at'));
      return [{ id, ...(expiresAt === undefined ? {} : { expiresAt }) }];
    });
    return { availableCount, ...(items.length === 0 ? {} : { items }) };
  } catch {
    return undefined;
  }
}

/** `rate_limit.primary_window` / `secondary_window`: the session and weekly lanes. */
function laneItems(usage: Readonly<Record<string, unknown>>): readonly OAuthQuotaItem[] {
  const rateLimit = Reflect.get(usage, 'rate_limit');
  if (!isPlainObject(rateLimit)) return [];
  return [
    windowItem(Reflect.get(rateLimit, 'primary_window'), 'primary', undefined),
    windowItem(Reflect.get(rateLimit, 'secondary_window'), 'secondary', undefined),
  ].filter((item): item is OAuthQuotaItem => item !== undefined);
}

/**
 * `additional_rate_limits[]` carries model-specific limits (GPT-5.x-Codex-Spark and the like)
 * alongside the two main lanes. One malformed entry must not discard its valid siblings.
 */
function additionalItems(usage: Readonly<Record<string, unknown>>): readonly OAuthQuotaItem[] {
  const raw = Reflect.get(usage, 'additional_rate_limits');
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): OAuthQuotaItem[] => {
    if (!isPlainObject(entry)) return [];
    const rateLimit = Reflect.get(entry, 'rate_limit');
    if (!isPlainObject(rateLimit)) return [];
    const name = nonEmpty(Reflect.get(entry, 'limit_name')) ?? nonEmpty(Reflect.get(entry, 'metered_feature'));
    const slug = slugify(nonEmpty(Reflect.get(entry, 'metered_feature')) ?? name ?? '');
    if (slug === '') return [];
    return [
      windowItem(Reflect.get(rateLimit, 'primary_window'), slug, name),
      windowItem(Reflect.get(rateLimit, 'secondary_window'), `${slug}-secondary`, name),
    ].filter((item): item is OAuthQuotaItem => item !== undefined);
  });
}

function windowItem(value: unknown, id: string, prefix: string | undefined): OAuthQuotaItem | undefined {
  if (!isPlainObject(value)) return undefined;
  const usedPercent = number(Reflect.get(value, 'used_percent'));
  const resetsAt = timestamp(Reflect.get(value, 'reset_at'));
  if (usedPercent === undefined && resetsAt === undefined) return undefined;
  const label = windowLabel(number(Reflect.get(value, 'limit_window_seconds')), id.endsWith('secondary'));
  return {
    id,
    displayName: prefix === undefined ? label : prefixed(prefix, label),
    ...(usedPercent === undefined ? {} : { remainingRatio: 1 - Math.min(Math.max(usedPercent, 0), 100) / 100 }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function windowLabel(limitWindowSeconds: number | undefined, secondaryLane: boolean): LocalizedText {
  if (limitWindowSeconds === undefined || limitWindowSeconds <= 0) {
    return secondaryLane
      ? { default: 'Weekly limit', 'zh-Hans': '周额度' }
      : { default: 'Session limit', 'zh-Hans': '会话额度' };
  }
  if (limitWindowSeconds === WEEK_SECONDS) return { default: 'Weekly limit', 'zh-Hans': '周额度' };
  const hours = limitWindowSeconds / 3_600;
  if (Number.isInteger(hours) && hours < 24) {
    return { default: `${hours}-hour limit`, 'zh-Hans': `${hours} 小时额度` };
  }
  const days = limitWindowSeconds / 86_400;
  if (Number.isInteger(days)) return { default: `${days}-day limit`, 'zh-Hans': `${days} 天额度` };
  return secondaryLane
    ? { default: 'Weekly limit', 'zh-Hans': '周额度' }
    : { default: 'Session limit', 'zh-Hans': '会话额度' };
}

function prefixed(prefix: string, label: LocalizedText): LocalizedText {
  const values = typeof label === 'string' ? { default: label } : label;
  return Object.fromEntries(
    Object.entries(values).map(([locale, text]) => [locale, `${prefix} · ${text}`]),
  ) as LocalizedText;
}

/** `plan_type` is an API enum (`plus`, `free_workspace`, …); the dashboard shows it verbatim. */
function planText(value: unknown): string | undefined {
  const plan = nonEmpty(value);
  if (plan === undefined) return undefined;
  return plan
    .split(/[\s_-]+/u)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// The core validator rejects duplicate item ids outright, so two entries naming the same metered
// feature must not both survive. Every id handed out is reserved, generated ones included.
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

function number(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(nonEmpty(value) ?? Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function integer(value: unknown): number | undefined {
  const parsed = number(value);
  return parsed === undefined || !Number.isSafeInteger(parsed) ? undefined : parsed;
}

/** `wham` spells window resets as epoch seconds and credit expiries as ISO-8601. */
function timestamp(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const millis = Math.trunc(value * 1_000);
  return Number.isSafeInteger(millis) ? millis : undefined;
}
