import { describe, expect, test } from 'bun:test';

import { requestAsksFastMode } from './fast-mode';

describe('requestAsksFastMode', () => {
  test('matches priority service_tier, fast speed, and the Anthropic fast-mode beta', () => {
    expect(requestAsksFastMode({ service_tier: 'priority' }, new Headers())).toBe(true);
    expect(requestAsksFastMode({ speed: 'fast' }, new Headers())).toBe(true);
    expect(
      requestAsksFastMode(
        {},
        new Headers({ 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14, fast-mode-2026-02-01' }),
      ),
    ).toBe(true);
  });

  test('ignores neighboring tiers, speeds, and unrelated beta tokens', () => {
    expect(requestAsksFastMode({ service_tier: 'flex' }, new Headers())).toBe(false);
    expect(requestAsksFastMode({ service_tier: 'fast' }, new Headers())).toBe(false);
    expect(requestAsksFastMode({ speed: 'standard' }, new Headers())).toBe(false);
    expect(requestAsksFastMode({}, new Headers({ 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14' }))).toBe(
      false,
    );
    expect(requestAsksFastMode(null, new Headers())).toBe(false);
  });
});
