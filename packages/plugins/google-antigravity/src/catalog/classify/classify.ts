import { isRecord } from '@aio-proxy/types';
export type ThinkingMode = 'gemini' | 'claude' | 'none';

export function classifyProvider(descriptor: { readonly id?: string; readonly extra?: unknown }): ThinkingMode {
  const providers = providerSource(descriptor.extra);
  const token = providerString(providers?.['apiProvider']) ?? providerString(providers?.['modelProvider']);
  if (token !== undefined) {
    if (token.includes('gemini')) return 'gemini';
    if (token.includes('anthropic')) return 'claude';
    return 'none';
  }
  const id = descriptor.id?.toLowerCase() ?? '';
  if (id.includes('claude') || id.includes('anthropic')) return 'claude';
  if (id.includes('gemini')) return 'gemini';
  return 'none';
}

function providerSource(extra: unknown): Record<string, unknown> | undefined {
  if (!isRecord(extra)) return undefined;
  return isRecord(extra['antigravity']) ? extra['antigravity'] : extra;
}

function providerString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? undefined : trimmed;
}
