import { describe, expect, test } from 'bun:test';

import { calibrationOutputTokens, codePointLength, createLiveMetrics, liveModelKey } from './index';

describe('live metrics', () => {
  test('counts Unicode code points and builds provider-qualified model keys', () => {
    expect(codePointLength('a中😀')).toBe(3);
    expect(codePointLength('')).toBe(0);
    expect(liveModelKey('a', 'b/c')).not.toBe(liveModelKey('a/b', 'c'));
  });

  test('accumulates chunks and excludes the current second from the three-second window', () => {
    let t = 100;
    const metrics = createLiveMetrics({ now: () => t });
    metrics.recordContent('p/m', 120);
    t = 900;
    metrics.recordContent('p/m', 120);
    expect(metrics.snapshot().outputTokensPerSecond).toBe(0);
    t = 1_000;
    expect(metrics.snapshot().outputTokensPerSecond).toBe(240 / 4 / 3);
    metrics.recordContent('p/m', 600);
    expect(metrics.snapshot().outputTokensPerSecond).toBe(20);
    t = 2_000;
    expect(metrics.snapshot().outputTokensPerSecond).toBe((240 + 600) / 4 / 3);
    t = 3_000;
    expect(metrics.snapshot().outputTokensPerSecond).toBe(70);
    t = 4_000;
    expect(metrics.snapshot().outputTokensPerSecond).toBe(50);
    t = 5_000;
    expect(metrics.snapshot().outputTokensPerSecond).toBe(0);
  });

  test('expires content after four seconds, including when the next operation is a write', () => {
    let t = 0;
    const metrics = createLiveMetrics({ now: () => t });
    metrics.recordContent('p/m', 120);
    t = 4_000;
    expect(metrics.snapshot().outputTokensPerSecond).toBe(0);
    metrics.recordContent('p/m', 240);
    t = 9_000;
    metrics.recordContent('p/m', 120);
    t = 10_000;
    expect(metrics.snapshot().outputTokensPerSecond).toBe(10);
  });

  test('calibrates each model independently and sums their throughput', () => {
    let t = 0;
    const metrics = createLiveMetrics({ now: () => t });
    metrics.calibrate('p/m', 200, 100);
    metrics.recordContent('p/m', 340);
    t = 1_000;
    expect(metrics.snapshot().outputTokensPerSecond).toBeCloseTo(340 / 3.4 / 3);
    metrics.recordContent('q/m', 120);
    t = 2_000;
    expect(metrics.snapshot().outputTokensPerSecond).toBeCloseTo(340 / 3.4 / 3 + 120 / 4 / 3);
  });

  test.each([
    [10_000, 1, 10],
    [1, 100, 0.5],
  ])('clamps calibration from %i chars and %i tokens to %f', (chars, tokens, ratio) => {
    let t = 0;
    const metrics = createLiveMetrics({ now: () => t });
    for (let i = 0; i < 20; i += 1) metrics.calibrate('p/m', chars, tokens);
    metrics.recordContent('p/m', 300);
    t = 1_000;
    expect(metrics.snapshot().outputTokensPerSecond).toBeCloseTo(300 / ratio / 3);
  });

  test('ignores zero characters or zero output tokens during calibration', () => {
    let t = 0;
    const metrics = createLiveMetrics({ now: () => t });
    metrics.calibrate('p/m', 200, 100);
    metrics.calibrate('p/m', 200, 0);
    metrics.calibrate('p/m', 0, 100);
    metrics.recordContent('p/m', 340);
    t = 1_000;
    expect(metrics.snapshot().outputTokensPerSecond).toBeCloseTo(340 / 3.4 / 3);
  });

  test('evicts the oldest calibration after 257 distinct models', () => {
    let t = 0;
    const metrics = createLiveMetrics({ now: () => t });
    for (let i = 0; i < 257; i += 1) metrics.calibrate(`p/m${i}`, 200, 100);
    metrics.recordContent('p/m0', 120);
    metrics.recordContent('p/m1', 340);
    t = 1_000;
    expect(metrics.snapshot().outputTokensPerSecond).toBeCloseTo(120 / 4 / 3 + 340 / 3.4 / 3);
  });

  test('refreshes calibration eviction order on updates, but not reads', () => {
    let t = 0;
    const metrics = createLiveMetrics({ now: () => t });
    for (let i = 0; i < 256; i += 1) metrics.calibrate(`p/m${i}`, 200, 100);
    metrics.calibrate('p/m0', 340, 100);
    metrics.recordContent('p/m1', 120);
    t = 1_000;
    expect(metrics.snapshot().outputTokensPerSecond).toBeCloseTo(120 / 3.4 / 3);
    metrics.calibrate('p/m256', 200, 100);
    metrics.recordContent('p/m0', 340);
    t = 2_000;
    expect(metrics.snapshot().outputTokensPerSecond).toBeCloseTo(120 / 4 / 3 + 340 / 3.4 / 3);
  });

  test('tracks concurrent requests without going below zero', () => {
    let t = 0;
    const metrics = createLiveMetrics({ now: () => t });
    expect(metrics.snapshot()).toEqual({ inFlight: 0, outputTokensPerSecond: 0 });
    metrics.requestStarted();
    metrics.requestStarted();
    t = 1_000;
    expect(metrics.snapshot().inFlight).toBe(2);
    metrics.requestFinished();
    expect(metrics.snapshot().inFlight).toBe(1);
    metrics.requestFinished();
    metrics.requestFinished();
    expect(metrics.snapshot().inFlight).toBe(0);
  });
});

describe('calibration output tokens', () => {
  test.each([
    [{ outputTokens: 10 }, { toolOutput: true, reasoningChars: 0 }, undefined],
    [{}, { toolOutput: false, reasoningChars: 0 }, undefined],
    [{ outputTokens: 0 }, { toolOutput: false, reasoningChars: 0 }, undefined],
    [{ outputTokens: -1 }, { toolOutput: false, reasoningChars: 0 }, undefined],
    [{ outputTokens: 10 }, { toolOutput: false, reasoningChars: undefined }, 10],
    [{ outputTokens: 10, reasoningTokens: 0 }, { toolOutput: false, reasoningChars: 0 }, 10],
    [{ outputTokens: 10, reasoningTokens: -1 }, { toolOutput: false, reasoningChars: 0 }, 10],
    [{ outputTokens: 10, reasoningTokens: 4 }, { toolOutput: false, reasoningChars: undefined }, undefined],
    [{ outputTokens: 10, reasoningTokens: 4 }, { toolOutput: false, reasoningChars: 0 }, 6],
    [{ outputTokens: 10, reasoningTokens: 4 }, { toolOutput: false, reasoningChars: 2 }, 10],
    [{ outputTokens: 10, reasoningTokens: 10 }, { toolOutput: false, reasoningChars: 0 }, undefined],
    [{ outputTokens: 10, reasoningTokens: 11 }, { toolOutput: false, reasoningChars: 0 }, undefined],
  ] as const)('matches counted characters for usage %j and observation %j', (usage, observed, expected) => {
    expect(calibrationOutputTokens(usage, observed)).toBe(expected);
  });
});
