import { describe, expect, test } from 'bun:test';

import { cooldownTtlMs } from './cooldown-write';

const cap = 30_000;
describe('cooldownTtlMs', () => {
  test('non-429 never cools', () => {
    expect(cooldownTtlMs(503, '5', cap)).toBe(0);
    expect(cooldownTtlMs(500, null, cap)).toBe(0);
  });
  test('429 numeric Retry-After within cap', () => {
    expect(cooldownTtlMs(429, '5', cap)).toBe(5_000);
  });
  test('429 Retry-After above cap clamps', () => {
    expect(cooldownTtlMs(429, '120', cap)).toBe(cap);
  });
  test('429 without parseable Retry-After does not cool', () => {
    expect(cooldownTtlMs(429, null, cap)).toBe(0);
    expect(cooldownTtlMs(429, 'garbage', cap)).toBe(0);
  });
});
