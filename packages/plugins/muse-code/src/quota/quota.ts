import type { AccountContext, LocalizedText, OAuthQuotaItem, OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { MuseCodeHttpError, requestMuseCodeKey, type MuseCodeKeyResponse } from '../control';
import { currentMuseCodeCredential, type MuseCodeOAuthOptions } from '../oauth';
import type { MuseCodeCredential } from '../schema';

const ROLLING_WINDOW: LocalizedText = { default: 'Rolling window', 'zh-Hans': '滚动窗口' };
const WEEKLY_WINDOW: LocalizedText = { default: 'Weekly quota', 'zh-Hans': '周配额' };

export class MuseCodeQuotaError extends Error {
  override readonly name = 'MuseCodeQuotaError';

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function readMuseCodeQuota(
  context: AccountContext<MuseCodeCredential, Record<string, never>>,
  options: MuseCodeOAuthOptions = {},
): Promise<OAuthQuotaSnapshot> {
  const fetcher = options.fetch ?? context.fetch ?? globalThis.fetch;
  const credential = await currentMuseCodeCredential(context.credentials, {
    ...options,
    fetch: fetcher,
    signal: context.signal,
  });
  let payload: MuseCodeKeyResponse;
  try {
    payload = await requestMuseCodeKey(credential.oauthAccessToken, {
      fetch: fetcher,
      signal: context.signal,
    });
  } catch (error) {
    throw mapQuotaFailure(error, context.signal);
  }
  if (payload.is_subs_active === false) {
    throw new MuseCodeQuotaError('Muse Code subscription is inactive', false);
  }
  const items = quotaItems(payload);
  if (items.length === 0) {
    throw new MuseCodeQuotaError('Muse Code quota response contains no usable windows', false);
  }
  const plan = nonEmpty(payload.subs_tier_name) ?? nonEmpty(payload.subs_tier_id);
  return { items, ...(plan === undefined ? {} : { plan }) };
}

function quotaItems(payload: MuseCodeKeyResponse): readonly OAuthQuotaItem[] {
  const usage = payload.subs_usage;
  const items: OAuthQuotaItem[] = [];
  const window = usageItem(usage?.window, 'window');
  if (window !== undefined) items.push(window);
  const weekly = usageItem(usage?.weekly, 'weekly');
  if (weekly !== undefined) items.push(weekly);
  return items;
}

function usageItem(value: unknown, kind: 'window' | 'weekly'): OAuthQuotaItem | undefined {
  if (!isPlainObject(value)) return undefined;
  const percent = usedPercent(Reflect.get(value, 'used_percent'));
  if (percent === undefined) return undefined;
  const remainingRatio = 1 - Math.min(percent, 100) / 100;
  const resets = parseResetsAt(Reflect.get(value, 'resets_at'));
  if (kind === 'weekly') {
    return {
      id: 'weekly',
      displayName: WEEKLY_WINDOW,
      remainingRatio,
      // The name says a week and the upstream reports no duration for this one, so it is the length.
      windowMinutes: 7 * 24 * 60,
      ...(resets === undefined ? {} : { resetsAt: resets }),
    };
  }
  const { id, displayName, windowMinutes } = windowIdentity(Reflect.get(value, 'window_duration_mins'));
  return {
    id,
    displayName,
    remainingRatio,
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(resets === undefined ? {} : { resetsAt: resets }),
  };
}

function usedPercent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The reported duration names the window and also measures it, so it is carried through as
 * `windowMinutes`: without it the dashboard knows when the window ends but not when it started, and
 * cannot place the even-burn mark. An unusable duration leaves both the name and the length generic.
 */
function windowIdentity(minutes: unknown): {
  readonly id: string;
  readonly displayName: LocalizedText;
  readonly windowMinutes?: number;
} {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
    return { id: 'window', displayName: ROLLING_WINDOW };
  }
  const windowMinutes = Math.round(minutes);
  const id = `${windowMinutes}m`;
  if (minutes >= 60) {
    const hours = minutes / 60;
    return {
      id,
      displayName: { default: hours === 1 ? `${hours} hour` : `${hours} hours`, 'zh-Hans': `${hours} 小时` },
      windowMinutes,
    };
  }
  return {
    id,
    displayName: {
      default: minutes === 1 ? `${minutes} minute` : `${minutes} minutes`,
      'zh-Hans': `${minutes} 分钟`,
    },
    windowMinutes,
  };
}

function parseResetsAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1_000 : value;
  }
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function mapQuotaFailure(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw signal.reason;
  if (isAbortError(error)) throw error;
  if (error instanceof MuseCodeHttpError) {
    throw new MuseCodeQuotaError('Muse Code quota request failed', error.retryable, error.status);
  }
  if (isTimeoutError(error)) {
    throw new MuseCodeQuotaError('Muse Code quota request failed', true);
  }
  throw new MuseCodeQuotaError('Muse Code quota request failed', false);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
