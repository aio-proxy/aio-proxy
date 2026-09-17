import type { OAuthQuotaItem, OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';

export type QuotaWindowEstimate = {
  readonly itemId: string;
  readonly usedNanoUsd: string;
  readonly basis: 'local-api-equivalent';
};

export type QuotaWindowCostQuery = {
  readonly start: Date;
  readonly end: Date;
};

export function quotaWindowBounds(
  item: Pick<OAuthQuotaItem, 'remainingRatio' | 'resetsAt' | 'windowMinutes'>,
  sampledAt: number,
): QuotaWindowCostQuery | undefined {
  if (item.remainingRatio === undefined) return undefined;
  const { resetsAt, windowMinutes } = item;
  if (resetsAt === undefined || windowMinutes === undefined || windowMinutes <= 0) return undefined;
  const durationMs = windowMinutes * 60_000;
  const remainingMs = resetsAt - sampledAt;
  if (remainingMs <= 0 || remainingMs > durationMs) return undefined;
  return { start: new Date(resetsAt - durationMs), end: new Date(sampledAt) };
}

export function quotaWindowEstimates(
  entry: { readonly snapshot: OAuthQuotaSnapshot; readonly sampledAt: number },
  cost: (range: QuotaWindowCostQuery) => string | undefined,
): readonly QuotaWindowEstimate[] | undefined {
  const cache = new Map<string, string | undefined>();
  const estimates: QuotaWindowEstimate[] = [];
  for (const item of entry.snapshot.items) {
    const bounds = quotaWindowBounds(item, entry.sampledAt);
    if (bounds === undefined) continue;
    const key = `${bounds.start.getTime()}:${bounds.end.getTime()}`;
    if (!cache.has(key)) cache.set(key, cost(bounds));
    const usedNanoUsd = cache.get(key);
    if (usedNanoUsd === undefined) continue;
    estimates.push({ itemId: item.id, usedNanoUsd, basis: 'local-api-equivalent' });
  }
  return estimates.length === 0 ? undefined : estimates;
}
