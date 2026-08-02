import { describe, expect, it } from 'bun:test';

import { UsageRowSchema } from './usage';

describe('UsageRowSchema fee/audio fields', () => {
  it('parses audio tokens and per-event counts, preserving exact values', () => {
    const parsed = UsageRowSchema.parse({
      providerId: 'p',
      modelId: 'm',
      imageCount: 2,
      webSearchCount: 1,
      inputAudioTokens: 10,
      outputAudioTokens: 5,
    });
    expect(parsed.imageCount).toBe(2);
    expect(parsed.webSearchCount).toBe(1);
    expect(parsed.inputAudioTokens).toBe(10);
    expect(parsed.outputAudioTokens).toBe(5);
  });

  it('rejects a negative count', () => {
    const result = UsageRowSchema.safeParse({ providerId: 'p', modelId: 'm', imageCount: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer count', () => {
    const result = UsageRowSchema.safeParse({ providerId: 'p', modelId: 'm', imageCount: 1.5 });
    expect(result.success).toBe(false);
  });

  it('treats the new fields as optional', () => {
    const result = UsageRowSchema.safeParse({ providerId: 'p', modelId: 'm' });
    expect(result.success).toBe(true);
  });
});
