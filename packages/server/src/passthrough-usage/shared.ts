import type { UsageRow } from '@aio-proxy/types';

export type ExtractedUsage = Omit<UsageRow, 'providerId' | 'modelId'>;

export const MAX_SSE_BUFFER_CHARS = 1024 * 1024;

export function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

export function tokenUsage(usage: ExtractedUsage): ExtractedUsage | undefined {
  const compact = Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined));
  return Object.keys(compact).length === 0 ? undefined : compact;
}

export function totalTokens(inputTokens: number | undefined, outputTokens: number | undefined): number | undefined {
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  return inputTokens + outputTokens;
}

export function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function nestedNumberField(record: Record<string, unknown>, parent: string, field: string): number | undefined {
  const value = record[parent];
  return isRecord(value) ? numberField(value, field) : undefined;
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
