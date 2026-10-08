import type { Database, SQLQueryBindings } from 'bun:sqlite';

import { UsageRowSchema } from '@aio-proxy/types';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { usdToNanoUsd } from '../../../usage-numbers';
import type { StoredSpan } from '../types';

// Only completed, billed attempts rejected during egress carry this ledger entry.
// Successful attempts remain accounted for by the root's existing usage row.
export function consumedUsage(span: Pick<StoredSpan, 'attributes'>) {
  const attrs = span.attributes;
  if (attrs['aio_proxy.usage.consumed'] !== true) return undefined;
  const parsed = UsageRowSchema.safeParse({
    providerId: attrs['aio_proxy.provider.id'],
    modelId: attrs['gen_ai.request.model'] ?? attrs['aio_proxy.attempt.model_id'],
    inputTokens: attrs['gen_ai.usage.input_tokens'],
    outputTokens: attrs['gen_ai.usage.output_tokens'],
    totalTokens: attrs['gen_ai.usage.total_tokens'],
    estimatedCostUsd: attrs['gen_ai.usage.estimated_cost_usd'],
    priceSource: attrs['aio_proxy.usage.price_source'],
    priceModelId: attrs['aio_proxy.usage.price_model_id'],
  });
  return parsed.success ? parsed.data : undefined;
}

export function consumedUsageRows(db: BunSQLiteDatabase, start: Date, end: Date) {
  const statement = (db as BunSQLiteDatabase & { $client: Database }).$client.query<
    {
      attributes: string;
      providerId: string;
      modelId: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
      endedAt: number;
      modelDimension: string;
      rootHasUsage: number;
      rootPriced: number;
      traceId: string;
    },
    SQLQueryBindings[]
  >(`
    select child.provider_id as providerId, child.model_id as modelId, child.input_tokens as inputTokens, child.output_tokens as outputTokens, child.total_tokens as totalTokens, child.attributes_json as attributes, root.ended_at as endedAt, root.trace_id as traceId,
      coalesce(root.requested_model_id, root.final_model_id, 'unknown') as modelDimension,
      case when root.input_tokens is not null or root.output_tokens is not null or root.total_tokens is not null
        or root.estimated_cost_nano_usd is not null then 1 else 0 end as rootHasUsage,
      case when root.estimated_cost_nano_usd is not null then 1 else 0 end as rootPriced
    from trace_span child join trace_span root on child.trace_id = root.trace_id and root.parent_span_id is null
    where child.parent_span_id is not null and child.attempt_index is not null
      and json_extract(child.attributes_json, '$."aio_proxy.usage.consumed"') is not null
      and root.ended_at >= ? and root.ended_at <= ?`);
  const seenUsage = new Set<string>();
  const seenPrice = new Set<string>();
  return statement.all(start.getTime(), end.getTime()).flatMap((row) => {
    const usage = consumedUsage({
      attributes: {
        ...JSON.parse(row.attributes),
        'aio_proxy.provider.id': row.providerId,
        ...(row.modelId === null ? {} : { 'gen_ai.request.model': row.modelId }),
        ...(row.inputTokens === null ? {} : { 'gen_ai.usage.input_tokens': row.inputTokens }),
        ...(row.outputTokens === null ? {} : { 'gen_ai.usage.output_tokens': row.outputTokens }),
        ...(row.totalTokens === null ? {} : { 'gen_ai.usage.total_tokens': row.totalTokens }),
      },
    });
    if (usage === undefined) return [];
    const cost = usage.estimatedCostUsd;
    const reportsUsage = [usage.inputTokens, usage.outputTokens, usage.totalTokens, cost].some(
      (value) => value !== undefined,
    );
    const hasUsage = reportsUsage && row.rootHasUsage === 0 && !seenUsage.has(row.traceId) ? 1 : 0;
    const priced = cost !== undefined && row.rootPriced === 0 && !seenPrice.has(row.traceId) ? 1 : 0;
    if (reportsUsage) seenUsage.add(row.traceId);
    if (cost !== undefined) seenPrice.add(row.traceId);
    return [
      {
        usage,
        endedAt: row.endedAt,
        modelDimension: row.modelDimension,
        dimension: usage.providerId,
        terminationReason: null,
        requestCount: 0n,
        hasUsage,
        priced,
        estimatedCostNanoUsd: BigInt(cost === undefined ? 0 : usdToNanoUsd(cost)),
        inputTokens: BigInt(usage.inputTokens ?? 0),
        outputTokens: BigInt(usage.outputTokens ?? 0),
        totalTokens: BigInt(usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
      },
    ];
  });
}
