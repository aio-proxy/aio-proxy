import { isPlainObject } from 'es-toolkit/predicate';

import { numberField, tokenUsage, type UsageExtraction } from '../shared';

/**
 * Video usage is whatever a JSON job body reports and nothing more. Official
 * OpenAI Videos has no `usage` field; compatible gateways may still send one.
 * `seconds` and file size are never converted to tokens.
 */
export function openAIVideoUsage(value: unknown): UsageExtraction {
  if (!isPlainObject(value) || !isPlainObject(value['usage'])) return { kind: 'absent' };
  const usage = value['usage'];
  return tokenUsage({
    inputTokens: numberField(usage, 'input_tokens', 'inputTokens'),
    outputTokens: numberField(usage, 'output_tokens', 'outputTokens'),
    totalTokens: numberField(usage, 'total_tokens', 'totalTokens'),
  });
}
