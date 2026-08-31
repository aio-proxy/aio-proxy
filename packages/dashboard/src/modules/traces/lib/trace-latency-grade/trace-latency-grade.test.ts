import { expect, test } from '@rstest/core';

import { firstResponseTimeGrade, latencyDotClassName, responseTimeGrade } from './trace-latency-grade';

test('grades TTFT on first-token wall-clock thresholds', () => {
  expect(firstResponseTimeGrade(4_999)).toBe('success');
  expect(firstResponseTimeGrade(5_000)).toBe('warning');
  expect(firstResponseTimeGrade(9_999)).toBe('warning');
  expect(firstResponseTimeGrade(10_000)).toBe('danger');
});

test('grades short-output duration on wall-clock', () => {
  expect(responseTimeGrade(9_999, 99)).toBe('success');
  expect(responseTimeGrade(10_000, 99)).toBe('warning');
  expect(responseTimeGrade(29_999, 0)).toBe('warning');
  expect(responseTimeGrade(30_000)).toBe('danger');
});

test('grades long-output duration on generated tokens per second', () => {
  expect(responseTimeGrade(8_000, 240)).toBe('success');
  expect(responseTimeGrade(8_000, 120)).toBe('warning');
  expect(responseTimeGrade(8_000, 100)).toBe('danger');
});

test('maps grades onto the existing latency-dot tokens', () => {
  expect(latencyDotClassName('success')).toContain('bg-primary');
  expect(latencyDotClassName('warning')).toContain('bg-amber-600');
  expect(latencyDotClassName('danger')).toContain('bg-destructive');
});
