import { type OpenRouterModelPrice, type UsageAccounting, usdToNanoUsd } from '@aio-proxy/core';
import { type UsageRow, UsageRowSchema } from '@aio-proxy/types';

import type { UsageIssue } from '../passthrough-usage/shared';
import { logServerEvent, type ServerLogSink } from '../server-log';
import { priceUsage } from './pricing';

export async function finalizeUsage(input: {
  readonly usage: UsageRow | undefined;
  readonly accounting: UsageAccounting;
  readonly logger?: ServerLogSink;
  readonly issues?: readonly UsageIssue[];
  readonly requestedModelId?: string;
  readonly configPrice?: OpenRouterModelPrice;
}): Promise<UsageRow | undefined> {
  const normalized = validUsage(input.usage, input.accounting, input.logger, input.issues);
  if (normalized === undefined) return undefined;
  const priced = await priceUsage(normalized, input.accounting, input.requestedModelId, input.configPrice);
  return validUsage(priced, input.accounting, input.logger, undefined, true);
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
