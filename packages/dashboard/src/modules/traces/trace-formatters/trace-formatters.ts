import { m } from '@aio-proxy/i18n';
import type { UsageRow } from '@aio-proxy/types';

import { createUsageValueFormatter } from '../../usage/services/usage-value-formatter';
import { TRACE_PLACEHOLDER } from '../trace-display-constants';

export const displayTotalTokens = (usage: UsageRow | undefined) =>
  usage?.totalTokens ??
  (usage?.inputTokens !== undefined && usage.outputTokens !== undefined
    ? usage.inputTokens + usage.outputTokens
    : undefined);

export const formatTraceCost = (cost: number | undefined, locale = navigator.language) =>
  cost === undefined ? TRACE_PLACEHOLDER : createUsageValueFormatter('cost', locale)(cost);

export const formatTraceDuration = (milliseconds: number, locale = navigator.language) =>
  milliseconds < 1_000
    ? m['dashboard.traces.duration_ms']({ value: new Intl.NumberFormat(locale).format(milliseconds) })
    : m['dashboard.traces.duration_s']({
        value: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(milliseconds / 1_000),
      });

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
