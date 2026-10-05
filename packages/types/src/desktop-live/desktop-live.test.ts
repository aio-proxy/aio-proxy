import { expect, test } from 'bun:test';

import { DesktopLiveV1Schema } from './desktop-live';
import fixture from './fixtures/v1.json' with { type: 'json' };

// Rust includes this same fixture, so parsing it protects the shared wire contract.
test('the shared v1 fixture is a valid desktop live snapshot', () => {
  expect(DesktopLiveV1Schema.parse(fixture)).toEqual(fixture);
});

test('desktop live snapshots reject extra fields', () => {
  expect(DesktopLiveV1Schema.safeParse({ ...fixture, extra: true }).success).toBe(false);
});

test('desktop live snapshots accept zero metrics', () => {
  expect(
    DesktopLiveV1Schema.safeParse({
      version: 1,
      todayTokens: '0',
      todayCostNanoUsd: '0',
      inFlight: 0,
      outputTokensPerSecond: 0,
    }).success,
  ).toBe(true);
});

test.each([-1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN])(
  'desktop live snapshots reject invalid output tokens per second: %s',
  (outputTokensPerSecond) => {
    expect(DesktopLiveV1Schema.safeParse({ ...fixture, outputTokensPerSecond }).success).toBe(false);
  },
);

test.each([-1, 1.5])('desktop live snapshots reject invalid in-flight counts: %s', (inFlight) => {
  expect(DesktopLiveV1Schema.safeParse({ ...fixture, inFlight }).success).toBe(false);
});

test.each([12, '-1', '1.5', '01'])('desktop live snapshots reject invalid integer strings: %s', (value) => {
  expect(DesktopLiveV1Schema.safeParse({ ...fixture, todayTokens: value }).success).toBe(false);
  expect(DesktopLiveV1Schema.safeParse({ ...fixture, todayCostNanoUsd: value }).success).toBe(false);
});

test('desktop live snapshots reject unsupported versions', () => {
  expect(DesktopLiveV1Schema.safeParse({ ...fixture, version: 2 }).success).toBe(false);
});
