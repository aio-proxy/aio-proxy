import { type OpenRouterModelPrice, type UsageAccounting, usdToNanoUsd } from '@aio-proxy/core';
import { type UsageRow, UsageRowSchema } from '@aio-proxy/types';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';

import type { UsageIssue } from '../passthrough-usage/shared';
import { currentRequestTraceRootContext } from '../request-logging/context';
import { attributeName, getTraceRuntime, spanName } from '../request-tracing';
import { logServerEvent, type ServerLogSink, serverErrorType } from '../server-log';
import { priceUsage } from './pricing';

export async function finalizeUsage(input: {
  readonly usage: UsageRow | undefined;
  readonly accounting: UsageAccounting;
  readonly logger?: ServerLogSink;
  readonly issues?: readonly UsageIssue[];
  readonly requestedModelId?: string;
  readonly configPrice?: OpenRouterModelPrice;
  readonly providerId?: string;
  readonly modelId?: string;
}): Promise<UsageRow | undefined> {
  const seed = seedForRequestFee(input);
  const candidate = input.usage ?? seed;
  if (candidate === undefined) return undefined;
  const resolve = async (): Promise<UsageRow | undefined> => {
    const normalized = validUsage(candidate, input.accounting, input.logger, input.issues);
    if (normalized === undefined) return undefined;
    const priced = await priceUsage(normalized, input.accounting, input.requestedModelId, input.configPrice);
    return validUsage(priced, input.accounting, input.logger, undefined, true);
  };
  const parent = currentRequestTraceRootContext();
  if (parent === undefined) return resolve();
  const span = getTraceRuntime().tracer.startSpan(spanName.usageResolve, { kind: SpanKind.INTERNAL }, parent);
  try {
    return await resolve();
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute(attributeName.errorType, serverErrorType(error));
    throw error;
  } finally {
    span.end();
  }
}

// A successful response can carry a flat per-request fee (cost.request) with no
// token usage. Callers reach finalizeUsage only on success, so when there is no
// usage but a positive request fee is configured, seed a minimal row so the fee
// is billed instead of silently dropped.
function seedForRequestFee(input: {
  readonly usage: UsageRow | undefined;
  readonly configPrice?: OpenRouterModelPrice;
  readonly providerId?: string;
  readonly modelId?: string;
}): UsageRow | undefined {
  if (input.usage !== undefined) return undefined;
  const requestFee = input.configPrice?.request;
  if (requestFee === undefined || !(requestFee > 0)) return undefined;
  if (input.providerId === undefined || input.modelId === undefined) return undefined;
  return { providerId: input.providerId, modelId: input.modelId };
}

function validUsage(
  usage: UsageRow | undefined,
  accounting: UsageAccounting,
  logger: ServerLogSink | undefined,
  upstreamIssues: readonly UsageIssue[] = [],
  checkNanoUsd = false,
): UsageRow | undefined {
  if (usage === undefined) return undefined;
  const parsed = UsageRowSchema.safeParse(usage);
  const issues: UsageIssue[] = [
    ...upstreamIssues,
    ...(parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.filter(
            (part): part is string | number => typeof part === 'string' || typeof part === 'number',
          ),
        }))),
  ];
  if (checkNanoUsd && usage.estimatedCostUsd !== undefined) {
    try {
      usdToNanoUsd(usage.estimatedCostUsd);
    } catch {
      issues.push({ code: 'unsafe_nano_usd', path: ['estimatedCostUsd'] });
    }
  }
  if (issues.length === 0 && parsed.success) return parsed.data;
  if (logger !== undefined) {
    logServerEvent(logger, {
      event: 'usage.accounting_dropped',
      source: accounting.source,
      providerId: usage.providerId,
      modelId: usage.modelId,
      reason: 'invalid_usage',
      issues,
    });
  }
  return undefined;
}
