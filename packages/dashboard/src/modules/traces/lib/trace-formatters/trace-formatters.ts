import type { UsageRow } from '@aio-proxy/types';

import { createUsageValueFormatter } from '@/lib/nano-usd';

import { TRACE_PLACEHOLDER } from '../trace-display-constants';

export const displayTotalTokens = (usage: UsageRow | undefined) =>
  usage?.totalTokens ??
  (usage?.inputTokens !== undefined && usage.outputTokens !== undefined
    ? usage.inputTokens + usage.outputTokens
    : undefined);

export const formatTraceCost = (cost: number | undefined, locale = navigator.language) =>
  cost === undefined ? TRACE_PLACEHOLDER : createUsageValueFormatter('cost', locale)(cost);

export const formatTraceResultDetails = (input: {
  readonly httpStatus?: number | undefined;
  readonly errorType?: string | undefined;
  readonly errorCode?: string | undefined;
}): string | undefined => {
  const values = [
    input.httpStatus === undefined ? undefined : `HTTP ${input.httpStatus}`,
    input.errorType,
    input.errorCode,
  ].filter((value): value is string => value !== undefined);
  return values.length === 0 ? undefined : values.join(' · ');
};
