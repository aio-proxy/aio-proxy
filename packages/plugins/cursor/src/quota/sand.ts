import type { OAuthQuotaItem, RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { isoTimestamp, remainingFromPercent } from './summary';

export const CURSOR_SAND_USAGE_URL = 'https://cursor.com/api/dashboard/get-sand-usage-status';
// Enrichment only: a stalled dashboard route must not hold the monthly bars open.
const SAND_TIMEOUT_MS = 4_000;

/**
 * Grok Bot (internally "Sand") weekly included usage. Never rejects: a failure, a timeout,
 * a malformed body, or an account with no Bot allowance all leave the monthly items intact.
 */
export async function readGrokBotItem(
  fetcher: RuntimeFetch,
  cookie: string,
  signal: AbortSignal,
): Promise<OAuthQuotaItem | undefined> {
  try {
    const response = await fetcher(CURSOR_SAND_USAGE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: cookie,
        // cursor.com gates its dashboard routes on a matching Origin.
        Origin: 'https://cursor.com',
      },
      body: '{}',
      signal: AbortSignal.any([signal, AbortSignal.timeout(SAND_TIMEOUT_MS)]),
      aioProxy: { traffic: 'control' },
    });
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    if (!isPlainObject(payload)) return undefined;
    if (Reflect.get(payload, 'hasNonZeroIncludedLimit') !== true) return undefined;
    const remainingRatio = remainingFromPercent(Reflect.get(payload, 'usagePercent'));
    if (remainingRatio === undefined) return undefined;
    const resetsAt = isoTimestamp(Reflect.get(payload, 'nextResetTimestampUtc'));
    return { id: 'grok-bot', displayName: 'Grok Bot', remainingRatio, ...(resetsAt === undefined ? {} : { resetsAt }) };
  } catch {
    return undefined;
  }
}
