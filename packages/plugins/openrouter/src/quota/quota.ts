import type { AccountContext, OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import type { OpenRouterOAuthOptions } from '../oauth/index';
import type { OpenRouterCredential } from '../schema/index';

const KEY_URL = 'https://openrouter.ai/api/v1/key';
const CREDITS_LABEL = { default: 'Credits', 'zh-Hans': '额度' } as const;

export async function readOpenRouterQuota(
  context: AccountContext<OpenRouterCredential, Record<string, never>>,
  options: OpenRouterOAuthOptions = {},
): Promise<OAuthQuotaSnapshot> {
  const { value } = await context.credentials.read();
  let response: Response;
  try {
    response = await (options.fetch ?? context.fetch ?? globalThis.fetch)(KEY_URL, {
      headers: { accept: 'application/json', authorization: `Bearer ${value.apiKey}` },
      signal: context.signal,
      aioProxy: { traffic: 'control' },
    });
  } catch {
    if (context.signal.aborted) throw context.signal.reason;
    throw new Error('OpenRouter key probe network failure');
  }
  if (!response.ok) throw new Error(`OpenRouter key probe failed (HTTP ${response.status})`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('OpenRouter key probe returned invalid JSON');
  }
  if (!isPlainObject(payload) || !isPlainObject(payload.data)) {
    throw new Error('OpenRouter key probe returned invalid data');
  }
  const limit = payload.data.limit;
  const remaining = payload.data.limit_remaining;
  if (limit === null) return { items: [] };
  if (
    typeof limit !== 'number' ||
    !Number.isFinite(limit) ||
    limit < 0 ||
    typeof remaining !== 'number' ||
    !Number.isFinite(remaining)
  ) {
    throw new Error('OpenRouter key probe returned invalid data');
  }
  const remainingRatio = limit === 0 ? 0 : Math.min(1, Math.max(0, remaining / limit));
  return {
    items: [{ id: 'credits', displayName: CREDITS_LABEL, remainingRatio }],
  };
}
