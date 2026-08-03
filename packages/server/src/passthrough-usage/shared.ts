import type { UsageRow } from '@aio-proxy/types';

export type ExtractedUsage = Omit<UsageRow, 'providerId' | 'modelId'>;
export type UsageIssue = {
  readonly code: string;
  readonly path: readonly (string | number)[];
};
export type UsageField =
  | 'inputTokens'
  | 'outputTokens'
  | 'totalTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'reasoningTokens'
  | 'inputAudioTokens'
  | 'outputAudioTokens';
export type UsageFieldResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly value: number }
  | { readonly kind: 'invalid'; readonly issue: UsageIssue };
export type UsageExtraction =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly usage: ExtractedUsage }
  | { readonly kind: 'invalid'; readonly issues: readonly UsageIssue[] };

export const MAX_SSE_BUFFER_CHARS = 1024 * 1024;

export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

export function tokenUsage(usage: Partial<Record<UsageField, UsageFieldResult>>): UsageExtraction {
  const issues: UsageIssue[] = [];
  const values: Partial<Record<UsageField, number>> = {};
  for (const [field, result] of Object.entries(usage) as [UsageField, UsageFieldResult][]) {
    if (result.kind === 'invalid') issues.push(result.issue);
    if (result.kind === 'valid') values[field] = result.value;
  }
  if (issues.length > 0) return { kind: 'invalid', issues };
  return Object.keys(values).length === 0 ? { kind: 'absent' } : { kind: 'valid', usage: values };
}

export function anthropicTotalTokens(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  cacheWriteTokens: number | undefined,
  cacheReadTokens: number | undefined,
): number | undefined {
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return inputTokens + outputTokens + (cacheWriteTokens ?? 0) + (cacheReadTokens ?? 0);
}

export function numberField(record: Record<string, unknown>, field: string, usageField: UsageField): UsageFieldResult {
  return usageNumber(record[field], usageField);
}

export function nestedNumberField(
  record: Record<string, unknown>,
  parent: string,
  field: string,
  usageField: UsageField,
): UsageFieldResult {
  const value = record[parent];
  return isRecord(value) ? numberField(value, field, usageField) : { kind: 'absent' };
}

export function usageNumber(value: unknown, field: UsageField): UsageFieldResult {
  if (value === undefined) return { kind: 'absent' };
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { kind: 'valid', value }
    : { kind: 'invalid', issue: { code: 'invalid_token_count', path: [field] } };
}

export function fieldValue(field: UsageFieldResult): number | undefined {
  return field.kind === 'valid' ? field.value : undefined;
}

export function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertNever(value: never): never {
  throw new Error(`Unsupported passthrough usage protocol: ${String(value)}`);
}
