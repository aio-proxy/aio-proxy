import type { JsonValue } from '@aio-proxy/plugin-sdk';

export const parseCompositeDraft = (type: 'object' | 'array', draft: string): JsonValue | undefined => {
  try {
    const parsed = JSON.parse(draft) as JsonValue;
    if (type === 'array') return Array.isArray(parsed) ? parsed : undefined;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};
