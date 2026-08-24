export type ThinkingMode = 'gemini' | 'claude' | 'none';

export function classifyProvider(descriptor: { readonly id?: string; readonly metadata?: unknown }): ThinkingMode {
  const providers = providerSource(descriptor.metadata);
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

function providerSource(metadata: unknown): Record<string, unknown> | undefined {
  if (!isRecord(metadata)) return undefined;
  return isRecord(metadata['antigravity']) ? metadata['antigravity'] : metadata;
}

function providerString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
