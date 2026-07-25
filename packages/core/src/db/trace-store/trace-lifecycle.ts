import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { traceSpan, usageDaily } from '../schema';
import { applyAffinity, pruneSessionState, upsertResponse } from './session-state';
import { projectAttributes } from './span-projection';
import type { StoredSpan, TraceCompletion, TraceRootStart } from './types';

function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function insertSpan(tx: BunSQLiteDatabase, span: StoredSpan, isRoot: boolean): void {
  const { columns, remaining } = projectAttributes(span.attributes, isRoot);
  tx.insert(traceSpan)
    .values({
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId ?? null,
      name: span.name,
      kind: span.kind,
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      statusCode: span.statusCode,
      attributes: remaining,
      events: [...span.events],
      links: [...span.links],
      ...columns,
    })
    .run();
}

export function startRoot(db: BunSQLiteDatabase, input: TraceRootStart): void {
  const { columns, remaining } = projectAttributes(input.attributes, true);
  db.insert(traceSpan)
    .values({
      traceId: input.traceId,
      spanId: input.spanId,
      parentSpanId: null,
      name: input.name,
      kind: input.kind,
      startedAt: input.startedAt,
      endedAt: null,
      statusCode: input.statusCode,
      attributes: remaining,
      events: [...input.events],
      links: [...input.links],
      ...columns,
    })
    .run();
}

function validateCompletion(input: TraceCompletion): void {
  const root = input.spans.find((span) => span.spanId === input.rootSpanId);
  if (root === undefined) {
    throw new Error('Completion must include the root span');
  }
  if (root.traceId !== input.traceId) {
    throw new Error('Root span trace id does not match completion trace id');
  }
  if (input.summary.usage !== undefined) {
    if (input.summary.usage.providerId !== input.summary.finalProviderId) {
      throw new Error('Usage provider id must match the final provider id');
    }
    if (input.summary.usage.modelId !== input.summary.finalModelId) {
      throw new Error('Usage model id must match the final model id');
    }
  }
  if (input.sessionState !== undefined && input.session === undefined) {
    throw new Error('sessionState requires session to be present');
  }
}

function upsertUsageDelta(tx: BunSQLiteDatabase, input: TraceCompletion, now: Date): void {
  const { summary, session } = input;
  const modelDimension = summary.finalModelId ?? session?.requestedModelId ?? 'unknown';
  const usage = summary.usage;
  const hasUsage = usage !== undefined;
  const success = summary.terminationReason === undefined;

  tx.insert(usageDaily)
    .values({
      localDay: localDay(now),
      modelDimension,
      requestCount: 1,
      successCount: success ? 1 : 0,
      errorCount: summary.terminationReason === 'failure' ? 1 : 0,
      cancelledCount: summary.terminationReason === 'cancelled' ? 1 : 0,
      interruptedCount: summary.terminationReason === 'interrupted' ? 1 : 0,
      usageRequestCount: hasUsage ? 1 : 0,
      pricedRequestCount: usage?.estimatedCostUsd !== undefined ? 1 : 0,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
      reasoningTokens: usage?.reasoningTokens ?? 0,
      estimatedCostUsd: usage?.estimatedCostUsd ?? 0,
    })
    .onConflictDoUpdate({
      target: [usageDaily.localDay, usageDaily.modelDimension],
      set: {
        requestCount: sql`request_count + excluded.request_count`,
        successCount: sql`success_count + excluded.success_count`,
        errorCount: sql`error_count + excluded.error_count`,
        cancelledCount: sql`cancelled_count + excluded.cancelled_count`,
        interruptedCount: sql`interrupted_count + excluded.interrupted_count`,
        usageRequestCount: sql`usage_request_count + excluded.usage_request_count`,
        pricedRequestCount: sql`priced_request_count + excluded.priced_request_count`,
        inputTokens: sql`input_tokens + excluded.input_tokens`,
        outputTokens: sql`output_tokens + excluded.output_tokens`,
        cacheReadTokens: sql`cache_read_tokens + excluded.cache_read_tokens`,
        cacheWriteTokens: sql`cache_write_tokens + excluded.cache_write_tokens`,
        reasoningTokens: sql`reasoning_tokens + excluded.reasoning_tokens`,
        estimatedCostUsd: sql`estimated_cost_usd + excluded.estimated_cost_usd`,
      },
    })
    .run();
}

export function complete(db: BunSQLiteDatabase, input: TraceCompletion): boolean {
  validateCompletion(input);

  const rootSpan = input.spans.find((span) => span.spanId === input.rootSpanId)!;
  const childSpans = input.spans.filter((span) => span.spanId !== input.rootSpanId);
  const endedAt = rootSpan.endedAt;
  const now = endedAt;

  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(traceSpan)
      .where(and(eq(traceSpan.traceId, input.traceId), eq(traceSpan.spanId, input.rootSpanId)))
      .get();

    if (existing !== undefined && existing.endedAt !== null) {
      return false;
    }

    const { columns, remaining } = projectAttributes(rootSpan.attributes, true);
    const terminalColumns = {
      ...columns,
      ...(input.summary.terminationReason !== undefined ? { terminationReason: input.summary.terminationReason } : {}),
      ...(input.summary.errorType !== undefined ? { errorType: input.summary.errorType } : {}),
      ...(input.summary.errorCode !== undefined ? { errorCode: input.summary.errorCode } : {}),
      ...(input.summary.finalProviderId !== undefined ? { finalProviderId: input.summary.finalProviderId } : {}),
      ...(input.summary.finalModelId !== undefined ? { finalModelId: input.summary.finalModelId } : {}),
      ...(input.summary.finalHttpStatus !== undefined ? { finalHttpStatus: input.summary.finalHttpStatus } : {}),
      ...(input.summary.usage?.priceModelId !== undefined ? { priceModelId: input.summary.usage.priceModelId } : {}),
      ...(input.summary.usage?.inputTokens !== undefined ? { inputTokens: input.summary.usage.inputTokens } : {}),
      ...(input.summary.usage?.outputTokens !== undefined ? { outputTokens: input.summary.usage.outputTokens } : {}),
      ...(input.summary.usage?.totalTokens !== undefined ? { totalTokens: input.summary.usage.totalTokens } : {}),
      ...(input.summary.usage?.cacheReadTokens !== undefined
        ? { cacheReadTokens: input.summary.usage.cacheReadTokens }
        : {}),
      ...(input.summary.usage?.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: input.summary.usage.cacheWriteTokens }
        : {}),
      ...(input.summary.usage?.reasoningTokens !== undefined
        ? { reasoningTokens: input.summary.usage.reasoningTokens }
        : {}),
      ...(input.summary.usage?.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: input.summary.usage.estimatedCostUsd }
        : {}),
    };

    if (existing === undefined) {
      tx.insert(traceSpan)
        .values({
          traceId: rootSpan.traceId,
          spanId: rootSpan.spanId,
          parentSpanId: rootSpan.parentSpanId ?? null,
          name: rootSpan.name,
          kind: rootSpan.kind,
          startedAt: rootSpan.startedAt,
          endedAt,
          statusCode: rootSpan.statusCode,
          attributes: remaining,
          events: [...rootSpan.events],
          links: [...rootSpan.links],
          ...terminalColumns,
        })
        .run();
    } else {
      tx.update(traceSpan)
        .set({
          endedAt,
          statusCode: rootSpan.statusCode,
          attributes: remaining,
          events: [...rootSpan.events],
          links: [...rootSpan.links],
          ...terminalColumns,
        })
        .where(and(eq(traceSpan.traceId, input.traceId), eq(traceSpan.spanId, input.rootSpanId)))
        .run();
    }

    for (const span of childSpans) {
      insertSpan(tx, span, false);
    }

    upsertUsageDelta(tx, input, now);

    if (input.sessionState?.responseId !== undefined && input.session !== undefined) {
      upsertResponse(tx, input.sessionState.responseId, input.session.identity, now);
    }

    if (
      input.sessionState !== undefined &&
      input.session !== undefined &&
      input.summary.terminationReason === undefined &&
      input.summary.finalProviderId !== undefined
    ) {
      applyAffinity(
        tx,
        input.session.identity,
        input.session.requestedModelId,
        input.summary.finalProviderId,
        input.sessionState.observedAffinity,
        now,
      );
    }

    return true;
  });
}

export function recover(db: BunSQLiteDatabase, now: Date): number {
  return db.transaction((tx) => {
    const running = tx.select().from(traceSpan).where(isNull(traceSpan.endedAt)).all();
    if (running.length === 0) {
      return 0;
    }
    for (const row of running) {
      tx.update(traceSpan)
        .set({ endedAt: now, statusCode: 2, terminationReason: 'interrupted' })
        .where(and(eq(traceSpan.traceId, row.traceId), eq(traceSpan.spanId, row.spanId)))
        .run();
    }
    tx.insert(usageDaily)
      .values({
        localDay: localDay(now),
        modelDimension: 'unknown',
        requestCount: running.length,
        interruptedCount: running.length,
      })
      .onConflictDoUpdate({
        target: [usageDaily.localDay, usageDaily.modelDimension],
        set: {
          requestCount: sql`request_count + excluded.request_count`,
          interruptedCount: sql`interrupted_count + excluded.interrupted_count`,
        },
      })
      .run();
    return running.length;
  });
}

export function prune(db: BunSQLiteDatabase, traceCutoff: Date, sessionCutoff: Date): void {
  db.transaction((tx) => {
    tx.delete(traceSpan)
      .where(and(isNull(traceSpan.parentSpanId), lt(traceSpan.endedAt, traceCutoff)))
      .run();
    pruneSessionState(tx, sessionCutoff);
  });
}
