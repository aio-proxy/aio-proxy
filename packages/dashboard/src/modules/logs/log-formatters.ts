import type { UsageRow } from "@aio-proxy/types";
import { createUsageValueFormatter } from "../usage/services/usage-value-formatter";

export const displayTotalTokens = (usage: UsageRow | undefined) =>
  usage?.totalTokens ??
  (usage?.inputTokens !== undefined && usage.outputTokens !== undefined
    ? usage.inputTokens + usage.outputTokens
    : undefined);

export const formatLogCost = (cost: number | undefined, locale = navigator.language) =>
  cost === undefined ? "—" : createUsageValueFormatter("cost", locale)(cost);

export const formatLogNumber = (value: number | undefined, locale = navigator.language) =>
  value === undefined ? "—" : new Intl.NumberFormat(locale).format(value);

export const formatDuration = (milliseconds: number, locale = navigator.language) =>
  milliseconds < 1_000
    ? `${new Intl.NumberFormat(locale).format(milliseconds)} ms`
    : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(milliseconds / 1_000)} s`;
